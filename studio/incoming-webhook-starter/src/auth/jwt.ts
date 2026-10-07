import type { Request } from "express";
import { OAuth2Client, type TokenPayload } from "google-auth-library";
import type { RootEventObject } from "../types.js";
import { getBaseUrl } from "../utils/url.js";

const googleClient = new OAuth2Client();

const VALID_ISSUERS = new Set([
	"https://accounts.google.com",
	"accounts.google.com",
]);

export class StudioAuthError extends Error {
	public readonly statusCode = 403;
	constructor(message: string) {
		super(message);
		this.name = "StudioAuthError";
	}
}

/**
 * Mockable token verifiers for testing.
 */
export type SystemTokenVerifierFn = (
	token: string,
	audience: string,
) => Promise<TokenPayload>;
export type UserTokenVerifierFn = (
	token: string,
	audience: string,
) => Promise<{ userId: string }>;

let customSystemTokenVerifier: SystemTokenVerifierFn | null = null;
let customUserTokenVerifier: UserTokenVerifierFn | null = null;

export function setSystemTokenVerifierForTesting(
	fn: SystemTokenVerifierFn | null,
): void {
	customSystemTokenVerifier = fn;
}

export function setUserTokenVerifierForTesting(
	fn: UserTokenVerifierFn | null,
): void {
	customUserTokenVerifier = fn;
}

/**
 * Convenience helper to set token verifiers for testing.
 */
export function setTokenVerifierForTesting(
	fn: ((token: string) => Promise<{ userId: string }>) | null,
): void {
	if (fn) {
		customUserTokenVerifier = async (token: string) => fn(token);
		customSystemTokenVerifier = async (token: string, audience: string) => {
			await fn(token);
			return {
				sub: "google-system-caller-sa-id",
				email:
					process.env.GOOGLE_ADDON_SERVICE_ACCOUNT_EMAIL ||
					"test-service-account@google.com",
				email_verified: true,
				aud: audience,
				iss: "https://accounts.google.com",
				iat: Math.floor(Date.now() / 1000),
				exp: Math.floor(Date.now() / 1000) + 3600,
			} as TokenPayload;
		};
	} else {
		customUserTokenVerifier = null;
		customSystemTokenVerifier = null;
	}
}

/**
 * Low-level token verification using Google's public keys via OAuth2Client.
 */
async function verifyGoogleIdToken(
	idToken: string,
	expectedAudience: string,
): Promise<TokenPayload> {
	const ticket = await googleClient.verifyIdToken({
		idToken,
		audience: expectedAudience,
	});
	const payload = ticket.getPayload();

	if (!payload) {
		throw new StudioAuthError("Invalid ID token: empty payload.");
	}

	if (!VALID_ISSUERS.has(payload.iss)) {
		throw new StudioAuthError(`Invalid token issuer: ${payload.iss}`);
	}

	const audMatch = Array.isArray(payload.aud)
		? payload.aud.includes(expectedAudience)
		: payload.aud === expectedAudience;

	if (!audMatch) {
		throw new StudioAuthError(
			`Token audience mismatch: expected '${expectedAudience}', got '${String(payload.aud)}'`,
		);
	}

	return payload;
}

/**
 * Verifies the system ID token to authenticate the sender (Google Workspace Studio)
 * and ensure the request was targeted to this add-on's endpoint URL.
 *
 * System ID token must be present in the `Authorization: Bearer <token>` header
 * or in `event.authorizationEventObject.systemIdToken`.
 *
 * Never falls back to or accepts a user ID token. An invalid or missing system ID
 * token fails the request entirely.
 */
export async function verifySystemIdToken(
	req: Request,
	event: RootEventObject,
): Promise<TokenPayload> {
	const authHeader = req.headers.authorization;
	const bearerToken = authHeader?.startsWith("Bearer ")
		? authHeader.slice("Bearer ".length).trim()
		: undefined;

	const rawToken = bearerToken || event.authorizationEventObject?.systemIdToken;

	if (!rawToken) {
		throw new StudioAuthError(
			"Missing system ID token in request authorization header or authorizationEventObject.",
		);
	}

	const invokedUrl = `${getBaseUrl(req)}${req.originalUrl}`;

	if (customSystemTokenVerifier) {
		return customSystemTokenVerifier(rawToken, invokedUrl);
	}

	const expectedServiceAccountEmail =
		process.env.GOOGLE_ADDON_SERVICE_ACCOUNT_EMAIL;
	if (!expectedServiceAccountEmail) {
		throw new StudioAuthError(
			"Server misconfiguration: GOOGLE_ADDON_SERVICE_ACCOUNT_EMAIL environment variable is not set.",
		);
	}

	const payload = await verifyGoogleIdToken(rawToken, invokedUrl);

	if (
		!payload.email_verified ||
		payload.email !== expectedServiceAccountEmail
	) {
		throw new StudioAuthError(
			`Service account mismatch: expected '${expectedServiceAccountEmail}', got '${String(payload.email)}'`,
		);
	}

	return payload;
}

/**
 * Verifies the user ID token to assert the end user interacting with the add-on.
 *
 * User ID token must be present in `event.authorizationEventObject.userIdToken`.
 * The audience must match GOOGLE_ADDON_CLIENT_ID.
 *
 * Never falls back to or accepts a system ID token. An invalid or missing user ID
 * token fails the request entirely.
 */
export async function verifyAddonUserIdToken(
	event: RootEventObject,
): Promise<string> {
	const rawToken = event.authorizationEventObject?.userIdToken;

	if (!rawToken) {
		throw new StudioAuthError(
			"Missing user ID token in authorizationEventObject.",
		);
	}

	const addonClientId = process.env.GOOGLE_ADDON_CLIENT_ID;

	if (customUserTokenVerifier) {
		const verified = await customUserTokenVerifier(
			rawToken,
			addonClientId || "test-client-id",
		);
		return verified.userId;
	}

	if (!addonClientId) {
		throw new StudioAuthError(
			"Server misconfiguration: GOOGLE_ADDON_CLIENT_ID is not set.",
		);
	}

	const payload = await verifyGoogleIdToken(rawToken, addonClientId);
	if (!payload.sub) {
		throw new StudioAuthError("Invalid user ID token: missing sub claim.");
	}

	return payload.sub;
}

/**
 * Authenticates an incoming Google Workspace Studio HTTP Add-on request requiring
 * both sender authentication and end-user identification.
 *
 * Independently validates:
 * 1. System ID token: Verifies the sender is Google and the request was targeted
 *    to this add-on's endpoint URL. If missing or invalid, the request fails entirely.
 * 2. User ID token: Asserts and verifies the identity of the end user against the
 *    configured add-on client ID. If missing or invalid, the request fails entirely.
 *
 * User and system tokens are NOT interchangeable and neither serves as a fallback
 * for the other.
 *
 * Returns the immutable Google Account ID (`userId` / `sub`).
 */
export async function authenticateStudioRequest(
	req: Request,
	event: RootEventObject,
): Promise<string> {
	// Validate both sender authenticity and end-user identity in parallel.
	// The request fails if either token is missing or invalid.
	const [, userId] = await Promise.all([
		verifySystemIdToken(req, event),
		verifyAddonUserIdToken(event),
	]);

	return userId;
}

/**
 * Verifies the OAuth 2.0 Web App ID token returned during `/auth/callback`.
 * Returns the user's immutable Google Account ID (`sub`).
 */
export async function verifyOAuthWebIdToken(idToken: string): Promise<string> {
	if (customUserTokenVerifier) {
		const verified = await customUserTokenVerifier(idToken, "oauth-client-id");
		return verified.userId;
	}

	const oauthClientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
	if (!oauthClientId) {
		throw new Error(
			"Server misconfiguration: GOOGLE_OAUTH_CLIENT_ID is not set.",
		);
	}

	const payload = await verifyGoogleIdToken(idToken, oauthClientId);
	if (!payload.sub) {
		throw new Error("Invalid OAuth ID token: missing sub claim.");
	}

	return payload.sub;
}
