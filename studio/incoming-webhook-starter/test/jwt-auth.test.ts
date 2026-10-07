import type { Request } from "express";
import { OAuth2Client, type TokenPayload } from "google-auth-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	authenticateStudioRequest,
	StudioAuthError,
	setSystemTokenVerifierForTesting,
	setTokenVerifierForTesting,
	setUserTokenVerifierForTesting,
	verifyAddonUserIdToken,
	verifyOAuthWebIdToken,
	verifySystemIdToken,
} from "../src/auth/jwt.js";
import type { RootEventObject } from "../src/types.js";

function createMockRequest(
	headers: Record<string, string> = {},
	originalUrl = "/studio/on-config",
): Request {
	return {
		headers: { ...headers },
		protocol: "https",
		originalUrl,
	} as unknown as Request;
}

function createMockEvent(
	systemIdToken?: string,
	userIdToken?: string,
): RootEventObject {
	return {
		authorizationEventObject: {
			systemIdToken,
			userIdToken,
		},
		commonEventObject: {},
	};
}

describe("JWT Authentication Unit Tests", () => {
	const originalEnv = { ...process.env };

	beforeEach(() => {
		process.env = { ...originalEnv };
		process.env.GOOGLE_ADDON_SERVICE_ACCOUNT_EMAIL =
			"test-sa@project.iam.gserviceaccount.com";
		process.env.GOOGLE_ADDON_CLIENT_ID =
			"test-addon-client-id.apps.googleusercontent.com";
		process.env.GOOGLE_OAUTH_CLIENT_ID =
			"test-oauth-client-id.apps.googleusercontent.com";
		process.env.PUBLIC_BASE_URL = "https://bridge.example.com";

		setSystemTokenVerifierForTesting(null);
		setUserTokenVerifierForTesting(null);
	});

	afterEach(() => {
		process.env = originalEnv;
		setSystemTokenVerifierForTesting(null);
		setUserTokenVerifierForTesting(null);
		vi.restoreAllMocks();
	});

	describe("StudioAuthError", () => {
		it("sets statusCode to 403 and name to StudioAuthError", () => {
			const err = new StudioAuthError("Forbidden action");
			expect(err.statusCode).toBe(403);
			expect(err.name).toBe("StudioAuthError");
			expect(err.message).toBe("Forbidden action");
		});
	});

	describe("verifySystemIdToken", () => {
		it("extracts token from Authorization: Bearer header when present", async () => {
			let passedToken = "";
			let passedAudience = "";
			setSystemTokenVerifierForTesting(async (token, aud) => {
				passedToken = token;
				passedAudience = aud;
				return { sub: "sa-123" } as TokenPayload;
			});

			const req = createMockRequest({
				authorization: "Bearer header-token-xyz",
			});
			const event = createMockEvent();

			const payload = await verifySystemIdToken(req, event);
			expect(passedToken).toBe("header-token-xyz");
			expect(passedAudience).toBe(
				"https://bridge.example.com/studio/on-config",
			);
			expect(payload.sub).toBe("sa-123");
		});

		it("extracts token from authorizationEventObject.systemIdToken when Authorization header is absent", async () => {
			let passedToken = "";
			setSystemTokenVerifierForTesting(async (token) => {
				passedToken = token;
				return { sub: "sa-123" } as TokenPayload;
			});

			const req = createMockRequest();
			const event = createMockEvent("event-system-token-abc");

			const payload = await verifySystemIdToken(req, event);
			expect(passedToken).toBe("event-system-token-abc");
			expect(payload.sub).toBe("sa-123");
		});

		it("prefers Authorization header over authorizationEventObject.systemIdToken", async () => {
			let passedToken = "";
			setSystemTokenVerifierForTesting(async (token) => {
				passedToken = token;
				return { sub: "sa-123" } as TokenPayload;
			});

			const req = createMockRequest({
				authorization: "Bearer header-priority-token",
			});
			const event = createMockEvent("event-token-ignored");

			await verifySystemIdToken(req, event);
			expect(passedToken).toBe("header-priority-token");
		});

		it("throws StudioAuthError (403) when system token is completely missing", async () => {
			const req = createMockRequest();
			const event = createMockEvent();

			await expect(verifySystemIdToken(req, event)).rejects.toThrow(
				StudioAuthError,
			);
			await expect(verifySystemIdToken(req, event)).rejects.toThrow(
				"Missing system ID token in request authorization header or authorizationEventObject.",
			);
		});

		it("throws StudioAuthError when GOOGLE_ADDON_SERVICE_ACCOUNT_EMAIL is not configured", async () => {
			delete process.env.GOOGLE_ADDON_SERVICE_ACCOUNT_EMAIL;
			const req = createMockRequest({ authorization: "Bearer some-token" });
			const event = createMockEvent();

			await expect(verifySystemIdToken(req, event)).rejects.toThrow(
				"Server misconfiguration: GOOGLE_ADDON_SERVICE_ACCOUNT_EMAIL environment variable is not set.",
			);
		});

		it("validates Google ID token against invoked URL and service account email", async () => {
			const verifySpy = vi
				.spyOn(OAuth2Client.prototype, "verifyIdToken")
				.mockResolvedValue({
					getPayload: () =>
						({
							iss: "https://accounts.google.com",
							aud: "https://bridge.example.com/studio/on-config",
							email: "test-sa@project.iam.gserviceaccount.com",
							email_verified: true,
							sub: "sa-sub-1",
						}) as TokenPayload,
				} as never);

			const req = createMockRequest({ authorization: "Bearer valid-sa-token" });
			const event = createMockEvent();

			const result = await verifySystemIdToken(req, event);
			expect(verifySpy).toHaveBeenCalledWith({
				idToken: "valid-sa-token",
				audience: "https://bridge.example.com/studio/on-config",
			});
			expect(result.sub).toBe("sa-sub-1");
		});

		it("rejects token when service account email does not match configured email", async () => {
			vi.spyOn(OAuth2Client.prototype, "verifyIdToken").mockResolvedValue({
				getPayload: () =>
					({
						iss: "https://accounts.google.com",
						aud: "https://bridge.example.com/studio/on-config",
						email: "wrong-sa@malicious.com",
						email_verified: true,
						sub: "sa-sub-1",
					}) as TokenPayload,
			} as never);

			const req = createMockRequest({
				authorization: "Bearer valid-token-wrong-sa",
			});
			const event = createMockEvent();

			await expect(verifySystemIdToken(req, event)).rejects.toThrow(
				"Service account mismatch: expected 'test-sa@project.iam.gserviceaccount.com', got 'wrong-sa@malicious.com'",
			);
		});

		it("rejects token when email_verified is false", async () => {
			vi.spyOn(OAuth2Client.prototype, "verifyIdToken").mockResolvedValue({
				getPayload: () =>
					({
						iss: "https://accounts.google.com",
						aud: "https://bridge.example.com/studio/on-config",
						email: "test-sa@project.iam.gserviceaccount.com",
						email_verified: false,
						sub: "sa-sub-1",
					}) as TokenPayload,
			} as never);

			const req = createMockRequest({
				authorization: "Bearer unverified-email-token",
			});
			const event = createMockEvent();

			await expect(verifySystemIdToken(req, event)).rejects.toThrow(
				StudioAuthError,
			);
		});

		it("rejects token when issuer is not Google accounts", async () => {
			vi.spyOn(OAuth2Client.prototype, "verifyIdToken").mockResolvedValue({
				getPayload: () =>
					({
						iss: "https://rogue-issuer.com",
						aud: "https://bridge.example.com/studio/on-config",
						email: "test-sa@project.iam.gserviceaccount.com",
						email_verified: true,
						sub: "sa-sub-1",
					}) as TokenPayload,
			} as never);

			const req = createMockRequest({
				authorization: "Bearer rogue-issuer-token",
			});
			const event = createMockEvent();

			await expect(verifySystemIdToken(req, event)).rejects.toThrow(
				"Invalid token issuer: https://rogue-issuer.com",
			);
		});

		it("rejects token when audience does not match invoked URL", async () => {
			vi.spyOn(OAuth2Client.prototype, "verifyIdToken").mockResolvedValue({
				getPayload: () =>
					({
						iss: "https://accounts.google.com",
						aud: "https://different-host.com/studio/on-config",
						email: "test-sa@project.iam.gserviceaccount.com",
						email_verified: true,
						sub: "sa-sub-1",
					}) as TokenPayload,
			} as never);

			const req = createMockRequest({
				authorization: "Bearer mismatch-aud-token",
			});
			const event = createMockEvent();

			await expect(verifySystemIdToken(req, event)).rejects.toThrow(
				"Token audience mismatch: expected 'https://bridge.example.com/studio/on-config', got 'https://different-host.com/studio/on-config'",
			);
		});
	});

	describe("verifyAddonUserIdToken", () => {
		it("extracts and returns userId from authorizationEventObject.userIdToken using custom verifier", async () => {
			let passedToken = "";
			let passedAudience = "";
			setUserTokenVerifierForTesting(async (token, aud) => {
				passedToken = token;
				passedAudience = aud;
				return { userId: "user-12345" };
			});

			const event = createMockEvent(undefined, "user-jwt-xyz");
			const userId = await verifyAddonUserIdToken(event);

			expect(passedToken).toBe("user-jwt-xyz");
			expect(passedAudience).toBe(
				"test-addon-client-id.apps.googleusercontent.com",
			);
			expect(userId).toBe("user-12345");
		});

		it("throws StudioAuthError when userIdToken is missing from authorizationEventObject", async () => {
			const event = createMockEvent("system-token-only", undefined);
			await expect(verifyAddonUserIdToken(event)).rejects.toThrow(
				"Missing user ID token in authorizationEventObject.",
			);
		});

		it("throws StudioAuthError when GOOGLE_ADDON_CLIENT_ID is not configured", async () => {
			delete process.env.GOOGLE_ADDON_CLIENT_ID;
			const event = createMockEvent(undefined, "user-token-abc");

			await expect(verifyAddonUserIdToken(event)).rejects.toThrow(
				"Server misconfiguration: GOOGLE_ADDON_CLIENT_ID is not set.",
			);
		});

		it("verifies user token against GOOGLE_ADDON_CLIENT_ID and returns sub claim", async () => {
			const verifySpy = vi
				.spyOn(OAuth2Client.prototype, "verifyIdToken")
				.mockResolvedValue({
					getPayload: () =>
						({
							iss: "https://accounts.google.com",
							aud: "test-addon-client-id.apps.googleusercontent.com",
							sub: "google-sub-998877",
						}) as TokenPayload,
				} as never);

			const event = createMockEvent(undefined, "valid-user-token");
			const userId = await verifyAddonUserIdToken(event);

			expect(verifySpy).toHaveBeenCalledWith({
				idToken: "valid-user-token",
				audience: "test-addon-client-id.apps.googleusercontent.com",
			});
			expect(userId).toBe("google-sub-998877");
		});

		it("throws StudioAuthError if user token payload is missing sub claim", async () => {
			vi.spyOn(OAuth2Client.prototype, "verifyIdToken").mockResolvedValue({
				getPayload: () =>
					({
						iss: "https://accounts.google.com",
						aud: "test-addon-client-id.apps.googleusercontent.com",
						// sub missing
					}) as TokenPayload,
			} as never);

			const event = createMockEvent(undefined, "token-without-sub");
			await expect(verifyAddonUserIdToken(event)).rejects.toThrow(
				"Invalid user ID token: missing sub claim.",
			);
		});
	});

	describe("authenticateStudioRequest", () => {
		it("validates systemIdToken and userIdToken in parallel and returns userId", async () => {
			setSystemTokenVerifierForTesting(
				async () => ({ sub: "sa-1" }) as TokenPayload,
			);
			setUserTokenVerifierForTesting(async () => ({ userId: "end-user-999" }));

			const req = createMockRequest({ authorization: "Bearer valid-sa-token" });
			const event = createMockEvent(undefined, "valid-user-token");

			const userId = await authenticateStudioRequest(req, event);
			expect(userId).toBe("end-user-999");
		});

		it("rejects when system token verification fails even if user token is valid", async () => {
			setSystemTokenVerifierForTesting(async () => {
				throw new StudioAuthError("System token invalid");
			});
			setUserTokenVerifierForTesting(async () => ({ userId: "end-user-999" }));

			const req = createMockRequest({
				authorization: "Bearer invalid-sa-token",
			});
			const event = createMockEvent(undefined, "valid-user-token");

			await expect(authenticateStudioRequest(req, event)).rejects.toThrow(
				"System token invalid",
			);
		});

		it("rejects when user token verification fails even if system token is valid", async () => {
			setSystemTokenVerifierForTesting(
				async () => ({ sub: "sa-1" }) as TokenPayload,
			);
			setUserTokenVerifierForTesting(async () => {
				throw new StudioAuthError("User token invalid");
			});

			const req = createMockRequest({ authorization: "Bearer valid-sa-token" });
			const event = createMockEvent(undefined, "invalid-user-token");

			await expect(authenticateStudioRequest(req, event)).rejects.toThrow(
				"User token invalid",
			);
		});

		it("rejects when both tokens are missing", async () => {
			const req = createMockRequest();
			const event = createMockEvent();

			await expect(authenticateStudioRequest(req, event)).rejects.toThrow(
				StudioAuthError,
			);
		});

		it("does not allow a user token to substitute for a missing system token", async () => {
			const req = createMockRequest();
			// Only userIdToken provided
			const event = createMockEvent(undefined, "valid-user-token");

			await expect(authenticateStudioRequest(req, event)).rejects.toThrow(
				"Missing system ID token in request authorization header or authorizationEventObject.",
			);
		});

		it("does not allow a system token to substitute for a missing user token", async () => {
			const req = createMockRequest({ authorization: "Bearer valid-sa-token" });
			// userIdToken missing
			const event = createMockEvent();

			await expect(authenticateStudioRequest(req, event)).rejects.toThrow(
				"Missing user ID token in authorizationEventObject.",
			);
		});
	});

	describe("verifyOAuthWebIdToken", () => {
		it("extracts and returns sub from valid OAuth Web App ID token", async () => {
			vi.spyOn(OAuth2Client.prototype, "verifyIdToken").mockResolvedValue({
				getPayload: () =>
					({
						iss: "https://accounts.google.com",
						aud: "test-oauth-client-id.apps.googleusercontent.com",
						sub: "oauth-user-777",
					}) as TokenPayload,
			} as never);

			const sub = await verifyOAuthWebIdToken("mock-oauth-id-token");
			expect(sub).toBe("oauth-user-777");
		});

		it("throws error when GOOGLE_OAUTH_CLIENT_ID is not configured", async () => {
			delete process.env.GOOGLE_OAUTH_CLIENT_ID;

			await expect(verifyOAuthWebIdToken("any-token")).rejects.toThrow(
				"Server misconfiguration: GOOGLE_OAUTH_CLIENT_ID is not set.",
			);
		});

		it("throws error when OAuth ID token has no sub claim", async () => {
			vi.spyOn(OAuth2Client.prototype, "verifyIdToken").mockResolvedValue({
				getPayload: () =>
					({
						iss: "https://accounts.google.com",
						aud: "test-oauth-client-id.apps.googleusercontent.com",
					}) as TokenPayload,
			} as never);

			await expect(verifyOAuthWebIdToken("token-no-sub")).rejects.toThrow(
				"Invalid OAuth ID token: missing sub claim.",
			);
		});

		it("supports custom user token verifier for testing", async () => {
			setUserTokenVerifierForTesting(async () => ({
				userId: "custom-oauth-user-888",
			}));

			const sub = await verifyOAuthWebIdToken("test-token");
			expect(sub).toBe("custom-oauth-user-888");
		});

		it("setTokenVerifierForTesting configures both system and user verifiers simultaneously", async () => {
			setTokenVerifierForTesting(async (token) => {
				if (token === "both-valid") return { userId: "user-both-123" };
				throw new StudioAuthError("Invalid token");
			});

			const req = createMockRequest({ authorization: "Bearer both-valid" });
			const event = createMockEvent(undefined, "both-valid");

			const userId = await authenticateStudioRequest(req, event);
			expect(userId).toBe("user-both-123");
		});
	});
});
