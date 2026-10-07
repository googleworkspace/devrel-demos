import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import {
	StudioAuthError,
	setTokenVerifierForTesting,
} from "../src/auth/jwt.js";
import {
	setTokenExchangerForTesting,
	setTokenRefresherForTesting,
} from "../src/auth/oauth.js";
import {
	addSecretForInstance,
	createSubscription,
	deleteSubscriptionByTriggerId,
	getActiveSubscriptionWithUser,
	getDb,
	getUserById,
	listSecretsByInstanceId,
	setDbForTesting,
	upsertUserTokens,
} from "../src/db/index.js";
import { hashWebhookSecret } from "../src/utils/url.js";
import { setStudioFetchForTesting } from "../src/webhook/routes.js";

describe("Webhook Bridge Studio Add-on Integration Tests", () => {
	const app = createApp();
	const TEST_USER_ID = "google-user-sub-999888777";
	const OTHER_USER_ID = "google-user-sub-111222333";

	beforeEach(() => {
		// Suppress expected console.error logs during error tests for clean reporting
		vi.spyOn(console, "error").mockImplementation(() => {});

		// Reset test doubles to ensure mock isolation across test cases
		setTokenVerifierForTesting(null);
		setTokenExchangerForTesting(null);
		setTokenRefresherForTesting(null);
		setStudioFetchForTesting(null);

		// Initialize fresh in-memory SQLite database for each test
		const memoryDb = getDb(":memory:");
		setDbForTesting(memoryDb);

		// Mock Google ID token verifier
		setTokenVerifierForTesting(async (token: string) => {
			if (token === "valid-studio-jwt") {
				return { userId: TEST_USER_ID };
			}
			if (token === "other-user-jwt") {
				return { userId: OTHER_USER_ID };
			}
			if (token === "unauth-studio-jwt") {
				return { userId: "unauth-user-sub-000" };
			}
			throw new StudioAuthError("Invalid JWT");
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	// Helper to start OAuth flow and extract CSRF token and cookie
	async function startOAuthFlow() {
		const startRes = await request(app)
			.get("/auth/start")
			.set("X-Forwarded-Proto", "https")
			.set("X-Forwarded-Host", "bridge.example.com");

		const cookies = startRes.headers["set-cookie"];
		const match = startRes.text.match(/name="csrfToken"\s+value="([^"]+)"/);
		const csrfToken = match?.[1];

		return { startRes, cookies, csrfToken };
	}

	// Helper to initiate OAuth flow and obtain session cookies + state
	async function initiateOAuthFlow() {
		const { cookies, csrfToken } = await startOAuthFlow();
		const initiateRes = await request(app)
			.post("/auth/initiate")
			.set("Cookie", cookies)
			.set("X-Forwarded-Proto", "https")
			.set("X-Forwarded-Host", "bridge.example.com")
			.type("form")
			.send({ csrfToken });

		const sessionCookies = initiateRes.headers["set-cookie"];
		const location = initiateRes.headers.location;
		const stateMatch = location?.match(/[?&]state=([^&]+)/);
		const oauthState = stateMatch?.[1];

		return { initiateRes, sessionCookies, location, oauthState };
	}

	describe("1. OAuth Web App Flow", () => {
		it("GET /auth/start renders interstitial page and sets signed CSRF cookie", async () => {
			const { startRes, cookies, csrfToken } = await startOAuthFlow();

			expect(startRes.status).toBe(200);
			expect(startRes.text).toContain("Connect Webhook Bridge");
			expect(cookies).toBeDefined();
			expect(csrfToken).toBeDefined();
		});

		it("POST /auth/initiate rejects request with 403 when CSRF token is wrong or missing", async () => {
			const { cookies } = await startOAuthFlow();

			const badInitiate = await request(app)
				.post("/auth/initiate")
				.set("Cookie", cookies)
				.type("form")
				.send({ csrfToken: "wrong-csrf-token" });

			expect(badInitiate.status).toBe(403);
			expect(badInitiate.text).toContain("Invalid or expired CSRF token");
		});

		it("POST /auth/initiate redirects to Google OAuth with valid CSRF token, PKCE challenge, and state", async () => {
			const { initiateRes, location, sessionCookies, oauthState } =
				await initiateOAuthFlow();

			expect(initiateRes.status).toBe(302);
			expect(location).toContain("accounts.google.com/o/oauth2/v2/auth");
			expect(location).toContain(
				"scope=openid%20https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fworkspace.studio.trigger",
			);
			expect(location).not.toContain("email"); // Verify email scope is NOT requested
			expect(sessionCookies).toBeDefined();
			expect(oauthState).toBeDefined();
		});

		it("GET /auth/callback returns 400 when OAuth session cookie is missing", async () => {
			const res = await request(app).get(
				"/auth/callback?code=mock-code&state=mock-state",
			);
			expect(res.status).toBe(400);
			expect(res.text).toContain("OAuth session expired or missing");
		});

		it("GET /auth/callback returns 403 when state parameter does not match session state", async () => {
			const { sessionCookies } = await initiateOAuthFlow();

			const mismatchRes = await request(app)
				.get("/auth/callback?code=mock-code&state=wrong-state")
				.set("Cookie", sessionCookies);

			expect(mismatchRes.status).toBe(403);
			expect(mismatchRes.text).toContain("OAuth state mismatch");
		});

		it("GET /auth/callback returns 400 when authorization code is missing", async () => {
			const { sessionCookies, oauthState } = await initiateOAuthFlow();

			const noCodeRes = await request(app)
				.get(`/auth/callback?state=${oauthState}`)
				.set("Cookie", sessionCookies);

			expect(noCodeRes.status).toBe(400);
			expect(noCodeRes.text).toContain("Missing authorization code");
		});

		it("GET /auth/callback exchanges authorization code and persists tokens in database", async () => {
			const { sessionCookies, oauthState } = await initiateOAuthFlow();
			const futureExpiry = Date.now() + 3600 * 1000;

			setTokenExchangerForTesting(async ({ code }) => {
				expect(code).toBe("mock-auth-code-123");
				return {
					refreshToken: "refresh-token-xyz",
					accessToken: "initial-cached-access-token",
					expiryDateMs: futureExpiry,
					idToken: "valid-studio-jwt",
				};
			});

			const callbackRes = await request(app)
				.get(`/auth/callback?code=mock-auth-code-123&state=${oauthState}`)
				.set("Cookie", sessionCookies);

			expect(callbackRes.status).toBe(200);
			expect(callbackRes.text).toContain("Account Authorized");

			// Verify user credentials were saved in SQLite
			const savedUser = getUserById(TEST_USER_ID);
			expect(savedUser).toBeDefined();
			expect(savedUser?.userId).toBe(TEST_USER_ID);
			expect(savedUser?.refreshToken).toBe("refresh-token-xyz");
			expect(savedUser?.accessToken).toBe("initial-cached-access-token");
			expect(savedUser?.accessTokenExpiry).toBe(futureExpiry);
		});

		it("GET /auth/callback returns 500 when token exchange fails", async () => {
			const { sessionCookies, oauthState } = await initiateOAuthFlow();

			setTokenExchangerForTesting(async () => {
				throw new Error("Token exchange network failure");
			});

			const failRes = await request(app)
				.get(`/auth/callback?code=bad-code&state=${oauthState}`)
				.set("Cookie", sessionCookies);

			expect(failRes.status).toBe(500);
			expect(failRes.text).toContain("Token exchange network failure");
		});
	});

	describe("2. Studio Add-on Configuration UI (/studio/on-config)", () => {
		it("renders authorization required card when user is not authorized", async () => {
			const unauthRes = await request(app)
				.post("/studio/on-config")
				.set("X-Forwarded-Proto", "https")
				.set("X-Forwarded-Host", "my-webhook-host.run.app")
				.send({
					authorizationEventObject: {
						systemIdToken: "unauth-studio-jwt",
						userIdToken: "unauth-studio-jwt",
					},
					commonEventObject: {},
				});

			expect(unauthRes.status).toBe(200);
			const cardStr = JSON.stringify(unauthRes.body);
			expect(cardStr).toContain("https://my-webhook-host.run.app/auth/start");
			expect(cardStr).toContain("Account Authorization Required");
		});

		it("renders webhook configuration card with materialized webhook URL when user is authorized", async () => {
			upsertUserTokens(
				{
					userId: TEST_USER_ID,
					refreshToken: "valid-token",
				},
				getDb(),
			);

			const authRes = await request(app)
				.post("/studio/on-config")
				.set("X-Forwarded-Proto", "https")
				.set("X-Forwarded-Host", "prod-bridge.example.org")
				.send({
					authorizationEventObject: {
						systemIdToken: "valid-studio-jwt",
						userIdToken: "valid-studio-jwt",
					},
					workflow: {
						elementConfiguration: {
							inputs: {
								instanceId: { stringValues: ["inst-xyz-789"] },
							},
						},
					},
					commonEventObject: {},
				});

			expect(authRes.status).toBe(200);
			const cardStr = JSON.stringify(authRes.body);
			expect(cardStr).toContain(
				"https://prod-bridge.example.org/webhook/inst-xyz-789",
			);
			expect(cardStr).not.toContain("Account Authorization Required");
		});
	});

	describe("3. Dynamic UI & Secret Management", () => {
		it("POST /studio/on-toggle-api-key generates initial secret and updates UI when requireApiKey is enabled", async () => {
			const toggleRes = await request(app)
				.post("/studio/on-toggle-api-key")
				.set("X-Forwarded-Proto", "https")
				.set("X-Forwarded-Host", "my-webhook-host.run.app")
				.send({
					authorizationEventObject: {
						systemIdToken: "valid-studio-jwt",
						userIdToken: "valid-studio-jwt",
					},
					commonEventObject: {
						formInputs: {
							instanceId: { stringInputs: { value: ["inst-uuid-1"] } },
							requireApiKey: { stringInputs: { value: ["true"] } },
						},
					},
				});

			expect(toggleRes.status).toBe(200);
			const replaceSection =
				toggleRes.body.action?.modifyOperations?.[0]?.replaceSection;
			expect(replaceSection).toBeDefined();
			expect(replaceSection.id).toBe("api_key_section");

			const sectionStr = JSON.stringify(replaceSection);
			expect(sectionStr).toContain("whsec_");
			expect(sectionStr).toContain("Regenerate Secret");

			// Verify secret was saved to SQLite and scoped to TEST_USER_ID
			const savedSecrets = listSecretsByInstanceId("inst-uuid-1", TEST_USER_ID);
			expect(savedSecrets.length).toBe(1);
			expect(savedSecrets[0].userId).toBe(TEST_USER_ID);
		});

		it("POST /studio/on-toggle-api-key updates UI when requireApiKey is disabled", async () => {
			const toggleRes = await request(app)
				.post("/studio/on-toggle-api-key")
				.send({
					authorizationEventObject: {
						systemIdToken: "valid-studio-jwt",
						userIdToken: "valid-studio-jwt",
					},
					commonEventObject: {
						formInputs: {
							instanceId: { stringInputs: { value: ["inst-uuid-1"] } },
							requireApiKey: { stringInputs: { value: ["false"] } },
						},
					},
				});

			expect(toggleRes.status).toBe(200);
			const replaceSection =
				toggleRes.body.action?.modifyOperations?.[0]?.replaceSection;
			expect(replaceSection).toBeDefined();
			const sectionStr = JSON.stringify(replaceSection);
			expect(sectionStr).not.toContain("Regenerate Secret");
		});

		it("POST /studio/on-add-secret generates and stores a new labeled secret hash and returns plaintext preview", async () => {
			const addRes = await request(app)
				.post("/studio/on-add-secret")
				.send({
					authorizationEventObject: {
						systemIdToken: "valid-studio-jwt",
						userIdToken: "valid-studio-jwt",
					},
					commonEventObject: {
						formInputs: {
							instanceId: { stringInputs: { value: ["inst-sec-1"] } },
							newSecretLabel: { stringInputs: { value: ["Production Key"] } },
						},
					},
				});

			expect(addRes.status).toBe(200);
			const cardStr = JSON.stringify(addRes.body);
			expect(cardStr).toContain("Production Key");
			expect(cardStr).toContain("whsec_");

			const savedSecrets = listSecretsByInstanceId("inst-sec-1", TEST_USER_ID);
			expect(savedSecrets.length).toBe(1);
			expect(savedSecrets[0].label).toContain("Production Key");
		});

		it("POST /studio/on-add-secret rejects attempt to add secret to an instance owned by another user", async () => {
			// Seed subscription belonging to OTHER_USER_ID
			upsertUserTokens({ userId: OTHER_USER_ID, refreshToken: "tok" }, getDb());
			createSubscription(
				{
					triggerId: "trig-other",
					instanceId: "inst-shared-id",
					userId: OTHER_USER_ID,
					notifyUri: "https://notify.example.com",
					requireApiKey: false,
				},
				getDb(),
			);

			// TEST_USER_ID tries to add secret to OTHER_USER_ID's instance
			const hijackRes = await request(app)
				.post("/studio/on-add-secret")
				.send({
					authorizationEventObject: {
						systemIdToken: "valid-studio-jwt",
						userIdToken: "valid-studio-jwt",
					},
					commonEventObject: {
						formInputs: {
							instanceId: { stringInputs: { value: ["inst-shared-id"] } },
						},
					},
				});

			expect(hijackRes.status).toBe(500);
		});

		it("POST /studio/on-delete-secret deletes secret by ID and refreshes secret list", async () => {
			// First add a secret
			await request(app)
				.post("/studio/on-add-secret")
				.send({
					authorizationEventObject: {
						systemIdToken: "valid-studio-jwt",
						userIdToken: "valid-studio-jwt",
					},
					commonEventObject: {
						formInputs: {
							instanceId: { stringInputs: { value: ["inst-del-test"] } },
						},
					},
				});

			const secretsBefore = listSecretsByInstanceId(
				"inst-del-test",
				TEST_USER_ID,
			);
			expect(secretsBefore.length).toBe(1);
			const secretIdToDelete = secretsBefore[0].secretId;

			// Delete the secret
			const deleteRes = await request(app)
				.post("/studio/on-delete-secret")
				.send({
					authorizationEventObject: {
						systemIdToken: "valid-studio-jwt",
						userIdToken: "valid-studio-jwt",
					},
					commonEventObject: {
						formInputs: {
							instanceId: { stringInputs: { value: ["inst-del-test"] } },
						},
						parameters: {
							secretId: secretIdToDelete,
						},
					},
				});

			expect(deleteRes.status).toBe(200);
			const secretsAfter = listSecretsByInstanceId(
				"inst-del-test",
				TEST_USER_ID,
			);
			expect(secretsAfter.length).toBe(0);
		});
	});

	describe("4. Workflow Lifecycle (/studio/on-manage)", () => {
		it("rejects triggerCreation with returnElementErrorAction when user has not authorized OAuth", async () => {
			const failManage = await request(app)
				.post("/studio/on-manage")
				.send({
					authorizationEventObject: {
						systemIdToken: "valid-studio-jwt",
						userIdToken: "valid-studio-jwt",
					},
					workflow: {
						triggerCreation: {
							triggerId: "trig-abc-123",
							notifyUri:
								"https://workspacestudio.googleapis.com/v1/triggers/trig-abc-123:fire",
							inputs: {
								instanceId: { stringValues: ["inst-abc"] },
							},
						},
					},
				});

			expect(failManage.status).toBe(200);
			expect(
				failManage.body.hostAppAction?.workflowAction?.returnElementErrorAction,
			).toBeDefined();
		});

		it("creates active subscription on valid triggerCreation when user is authorized", async () => {
			upsertUserTokens(
				{
					userId: TEST_USER_ID,
					refreshToken: "valid-refresh-token",
				},
				getDb(),
			);

			const successManage = await request(app)
				.post("/studio/on-manage")
				.send({
					authorizationEventObject: {
						systemIdToken: "valid-studio-jwt",
						userIdToken: "valid-studio-jwt",
					},
					workflow: {
						triggerCreation: {
							triggerId: "trig-abc-123",
							notifyUri:
								"https://workspacestudio.googleapis.com/v1/triggers/trig-abc-123:fire",
							inputs: {
								instanceId: { stringValues: ["inst-abc"] },
								requireApiKey: { booleanValues: [true] },
							},
						},
					},
				});

			expect(successManage.status).toBe(200);
			expect(successManage.body).toEqual({});

			const sub = getActiveSubscriptionWithUser("trig-abc-123");
			expect(sub).toBeDefined();
			expect(sub?.subscription.triggerId).toBe("trig-abc-123");
			expect(sub?.subscription.instanceId).toBe("inst-abc");
			expect(sub?.subscription.requireApiKey).toBe(true);
		});

		it("deletes subscription upon triggerDeletion", async () => {
			upsertUserTokens({ userId: TEST_USER_ID, refreshToken: "tok" }, getDb());
			createSubscription(
				{
					triggerId: "trig-to-delete",
					instanceId: "inst-delete-me",
					userId: TEST_USER_ID,
					notifyUri: "https://notify.example.com",
					requireApiKey: false,
				},
				getDb(),
			);

			expect(getActiveSubscriptionWithUser("trig-to-delete")).toBeDefined();

			const deleteRes = await request(app)
				.post("/studio/on-manage")
				.send({
					authorizationEventObject: {
						systemIdToken: "valid-studio-jwt",
						userIdToken: "valid-studio-jwt",
					},
					workflow: {
						triggerDeletion: {
							triggerId: "trig-to-delete",
						},
					},
				});

			expect(deleteRes.status).toBe(200);
			expect(getActiveSubscriptionWithUser("trig-to-delete")).toBeUndefined();
		});

		it("decommissions associated secrets when last subscription for an instance is deleted", async () => {
			upsertUserTokens({ userId: TEST_USER_ID, refreshToken: "tok" }, getDb());
			createSubscription(
				{
					triggerId: "trig-with-secrets",
					instanceId: "inst-clean-secrets",
					userId: TEST_USER_ID,
					notifyUri: "https://notify.example.com",
					requireApiKey: true,
				},
				getDb(),
			);

			// Add secret for this instance
			await request(app)
				.post("/studio/on-add-secret")
				.send({
					authorizationEventObject: {
						systemIdToken: "valid-studio-jwt",
						userIdToken: "valid-studio-jwt",
					},
					commonEventObject: {
						formInputs: {
							instanceId: { stringInputs: { value: ["inst-clean-secrets"] } },
						},
					},
				});

			expect(
				listSecretsByInstanceId("inst-clean-secrets", TEST_USER_ID).length,
			).toBe(1);

			// Delete trigger subscription
			deleteSubscriptionByTriggerId("trig-with-secrets");

			// Secrets for this instance should be cleaned up
			expect(
				listSecretsByInstanceId("inst-clean-secrets", TEST_USER_ID).length,
			).toBe(0);
		});
	});

	describe("5. Incoming Webhook Ingestion & Dispatch (/webhook/:identifier)", () => {
		const TRIGGER_ID = "trig-webhook-test";
		const INSTANCE_ID = "inst-webhook-test";
		const RAW_SECRET = "whsec_supersecretkey123";

		beforeEach(() => {
			const db = getDb();
			upsertUserTokens(
				{
					userId: TEST_USER_ID,
					refreshToken: "valid-refresh-token",
					accessToken: "cached-token-valid-111",
					accessTokenExpiry: Date.now() + 3600 * 1000,
				},
				db,
			);

			createSubscription(
				{
					triggerId: TRIGGER_ID,
					instanceId: INSTANCE_ID,
					userId: TEST_USER_ID,
					notifyUri:
						"https://workspacestudio.googleapis.com/v1/triggers/trig-webhook-test:fire",
					requireApiKey: true,
				},
				db,
			);

			// Seed secret
			addSecretForInstance(
				{
					secretId: randomUUID(),
					instanceId: INSTANCE_ID,
					userId: TEST_USER_ID,
					label: "Test Secret",
					secretHash: hashWebhookSecret(RAW_SECRET),
				},
				db,
			);
		});

		it("rejects payloads larger than 1 KB with 413 Payload Too Large", async () => {
			const oversizedPayload = "a".repeat(1025);
			const res = await request(app)
				.post(`/webhook/${TRIGGER_ID}`)
				.set("X-Webhook-Secret", RAW_SECRET)
				.set("Content-Type", "text/plain")
				.send(oversizedPayload);

			expect(res.status).toBe(413);
			expect(res.body.error).toContain("Payload Too Large");
		});

		it("returns 404 when trigger or instance does not exist", async () => {
			const res = await request(app)
				.post("/webhook/nonexistent-trigger")
				.set("X-Webhook-Secret", RAW_SECRET)
				.send({ data: "hello" });

			expect(res.status).toBe(404);
			expect(res.body.error).toContain("No active webhook subscription found");
		});

		it("returns 401 when API key is required but missing from request", async () => {
			const res = await request(app)
				.post(`/webhook/${TRIGGER_ID}`)
				.send({ hello: "world" });

			expect(res.status).toBe(401);
			expect(res.body.error).toContain("Missing secret");
		});

		it("returns 401 when provided API key secret is invalid", async () => {
			const res = await request(app)
				.post(`/webhook/${TRIGGER_ID}`)
				.set("X-Webhook-Secret", "wrong-secret-value")
				.send({ hello: "world" });

			expect(res.status).toBe(401);
			expect(res.body.error).toContain("Invalid API key secret");
		});

		it("accepts valid secret via X-Webhook-Secret header and dispatches with cached token", async () => {
			let refreshCallCount = 0;
			setTokenRefresherForTesting(async () => {
				refreshCallCount++;
				return {
					accessToken: "refreshed-token",
					expiryDateMs: Date.now() + 3600 * 1000,
				};
			});

			let dispatchedAuthHeader = "";
			let dispatchedBody: unknown = null;
			setStudioFetchForTesting(async (_url, init) => {
				const headers = init?.headers as Record<string, string>;
				dispatchedAuthHeader = headers.Authorization;
				dispatchedBody = JSON.parse(String(init?.body));
				return new Response(JSON.stringify({ result: "dispatched" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			});

			const res = await request(app)
				.post(`/webhook/${TRIGGER_ID}`)
				.set("X-Webhook-Secret", RAW_SECRET)
				.set("Content-Type", "application/json")
				.send('{"event":"order.completed"}');

			expect(res.status).toBe(200);
			expect(refreshCallCount).toBe(0); // Cached token was reused without refresh
			expect(dispatchedAuthHeader).toBe("Bearer cached-token-valid-111");
			expect(dispatchedBody).toMatchObject({
				name: `triggers/${TRIGGER_ID}`,
				outputs: {
					rawPayload: {
						stringValues: ['{"event":"order.completed"}'],
					},
				},
			});
		});

		it("accepts valid secret via Authorization: ApiKey header", async () => {
			setStudioFetchForTesting(async () => {
				return new Response(JSON.stringify({}), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			});

			const res = await request(app)
				.post(`/webhook/${TRIGGER_ID}`)
				.set("Authorization", `ApiKey ${RAW_SECRET}`)
				.set("Content-Type", "application/json")
				.send('{"event":"auth_header_test"}');

			expect(res.status).toBe(200);
			expect(res.body.status).toBe("ok");
		});

		it("refreshes expired OAuth access token before dispatching and updates database", async () => {
			// Expire user access token in SQLite
			upsertUserTokens(
				{
					userId: TEST_USER_ID,
					refreshToken: "valid-refresh-token",
					accessToken: "old-expired-token",
					accessTokenExpiry: Date.now() - 10000, // Expired 10s ago
				},
				getDb(),
			);

			let refreshCount = 0;
			setTokenRefresherForTesting(async () => {
				refreshCount++;
				return {
					accessToken: `fresh-token-${refreshCount}`,
					expiryDateMs: Date.now() + 3600 * 1000,
				};
			});

			let headerUsed = "";
			setStudioFetchForTesting(async (_url, init) => {
				const headers = init?.headers as Record<string, string> | undefined;
				headerUsed = headers?.Authorization || "";
				return new Response(JSON.stringify({}), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			});

			const res1 = await request(app)
				.post(`/webhook/${TRIGGER_ID}`)
				.set("X-Webhook-Secret", RAW_SECRET)
				.send('{"msg":"first"}');

			expect(res1.status).toBe(200);
			expect(refreshCount).toBe(1);
			expect(headerUsed).toBe("Bearer fresh-token-1");

			// Subsequent dispatch should use the newly cached token without calling refresher again
			const res2 = await request(app)
				.post(`/webhook/${TRIGGER_ID}`)
				.set("X-Webhook-Secret", RAW_SECRET)
				.send('{"msg":"second"}');

			expect(res2.status).toBe(200);
			expect(refreshCount).toBe(1); // Still 1!
		});

		it("relays upstream 429 Too Many Requests status and Retry-After header", async () => {
			setStudioFetchForTesting(async () => {
				return new Response(
					JSON.stringify({
						error: {
							code: 429,
							message: "Rate limit exceeded",
							status: "RESOURCE_EXHAUSTED",
						},
					}),
					{
						status: 429,
						headers: {
							"Content-Type": "application/json",
							"Retry-After": "60",
						},
					},
				);
			});

			const res = await request(app)
				.post(`/webhook/${TRIGGER_ID}`)
				.set("X-Webhook-Secret", RAW_SECRET)
				.send('{"rate":"limited"}');

			expect(res.status).toBe(429);
			expect(res.headers["retry-after"]).toBe("60");
			expect(res.body.error?.status).toBe("RESOURCE_EXHAUSTED");
		});

		it("decommissions local subscription when upstream Studio returns 404 Not Found", async () => {
			setStudioFetchForTesting(async () => {
				return new Response(
					JSON.stringify({
						error: {
							code: 404,
							message: "Trigger deleted upstream.",
							status: "NOT_FOUND",
						},
					}),
					{
						status: 404,
						headers: { "Content-Type": "application/json" },
					},
				);
			});

			const res = await request(app)
				.post(`/webhook/${TRIGGER_ID}`)
				.set("X-Webhook-Secret", RAW_SECRET)
				.send('{"check":"decommission"}');

			expect(res.status).toBe(404);
			// Verify subscription was removed from SQLite
			expect(getActiveSubscriptionWithUser(TRIGGER_ID)).toBeUndefined();
		});

		it("relays other upstream errors back to caller with status and error message", async () => {
			setStudioFetchForTesting(async () => {
				return new Response(
					JSON.stringify({
						error: {
							code: 500,
							message: "Internal server error in Workspace Studio",
						},
					}),
					{
						status: 500,
						headers: { "Content-Type": "application/json" },
					},
				);
			});

			const res = await request(app)
				.post(`/webhook/${TRIGGER_ID}`)
				.set("X-Webhook-Secret", RAW_SECRET)
				.send('{"trigger":"internal_error"}');

			expect(res.status).toBe(500);
			expect(res.body.error?.message).toContain(
				"Internal server error in Workspace Studio",
			);
		});
	});

	describe("6. Studio Request Authentication Integration", () => {
		it("rejects request when both system and user tokens are missing with 403", async () => {
			const res = await request(app)
				.post("/studio/on-config")
				.send({ commonEventObject: {} });

			expect(res.status).toBe(403);
			expect(res.body.error).toContain("Missing system ID token");
		});

		it("rejects request when userIdToken is missing with 403", async () => {
			const res = await request(app)
				.post("/studio/on-config")
				.send({
					authorizationEventObject: { systemIdToken: "valid-studio-jwt" },
					commonEventObject: {},
				});

			expect(res.status).toBe(403);
			expect(res.body.error).toContain("Missing user ID token");
		});

		it("rejects request when systemIdToken is missing with 403", async () => {
			const res = await request(app)
				.post("/studio/on-config")
				.send({
					authorizationEventObject: { userIdToken: "valid-studio-jwt" },
					commonEventObject: {},
				});

			expect(res.status).toBe(403);
			expect(res.body.error).toContain("Missing system ID token");
		});

		it("rejects request when userIdToken is invalid with 403", async () => {
			const res = await request(app)
				.post("/studio/on-config")
				.send({
					authorizationEventObject: {
						systemIdToken: "valid-studio-jwt",
						userIdToken: "invalid-jwt-token",
					},
					commonEventObject: {},
				});

			expect(res.status).toBe(403);
			expect(res.body.error).toBe("Invalid JWT");
		});

		it("rejects request when systemIdToken is invalid with 403", async () => {
			const res = await request(app)
				.post("/studio/on-config")
				.send({
					authorizationEventObject: {
						systemIdToken: "invalid-jwt-token",
						userIdToken: "valid-studio-jwt",
					},
					commonEventObject: {},
				});

			expect(res.status).toBe(403);
			expect(res.body.error).toBe("Invalid JWT");
		});
	});
});
