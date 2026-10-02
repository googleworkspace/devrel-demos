import type { Request } from 'express';
import { OAuth2Client, type TokenPayload } from 'google-auth-library';
import type { RootEventObject } from '../types.js';
import { getBaseUrl } from '../utils/url.js';

const googleClient = new OAuth2Client();

const VALID_ISSUERS = new Set([
  'https://accounts.google.com',
  'accounts.google.com',
]);

export class StudioAuthError extends Error {
  public readonly statusCode = 403;
  constructor(message: string) {
    super(message);
    this.name = 'StudioAuthError';
  }
}

/**
 * Mockable token verifier for testing. Returns `{ userId: string }` if valid,
 * or throws an Error if invalid.
 */
export type TokenVerifierFn = (token: string) => Promise<{ userId: string }>;
let customTokenVerifier: TokenVerifierFn | null = null;

export function setTokenVerifierForTesting(fn: TokenVerifierFn | null): void {
  customTokenVerifier = fn;
}

/**
 * Low-level token verification using Google's public keys via OAuth2Client.
 */
async function verifyGoogleIdToken(
  idToken: string,
  expectedAudience: string
): Promise<TokenPayload> {
  const ticket = await googleClient.verifyIdToken({
    idToken,
    audience: expectedAudience,
  });
  const payload = ticket.getPayload();

  if (!payload) {
    throw new StudioAuthError('Invalid ID token: empty payload.');
  }

  if (!VALID_ISSUERS.has(payload.iss)) {
    throw new StudioAuthError(`Invalid token issuer: ${payload.iss}`);
  }

  const audMatch = Array.isArray(payload.aud)
    ? payload.aud.includes(expectedAudience)
    : payload.aud === expectedAudience;

  if (!audMatch) {
    throw new StudioAuthError(
      `Token audience mismatch: expected '${expectedAudience}', got '${String(payload.aud)}'`
    );
  }

  return payload;
}

/**
 * Authenticates an incoming Google Workspace Studio HTTP Add-on request.
 *
 * Trust Model:
 * 1. Google calls the add-on endpoint with a JWT in the `Authorization: Bearer <token>`
 *    header or in `event.authorizationEventObject.systemIdToken`.
 * 2. If present, `event.authorizationEventObject.userIdToken` identifies the end-user.
 * 3. In test environments, `setTokenVerifierForTesting` intercepts this verification.
 *
 * Returns the immutable Google Account ID (`userId` / `sub`).
 */
export async function authenticateStudioRequest(
  req: Request,
  event: RootEventObject
): Promise<string> {
  // Extract token from Bearer header or event authorizationEventObject
  const authHeader = req.headers.authorization;
  const bearerToken =
    authHeader && authHeader.startsWith('Bearer ')
      ? authHeader.slice('Bearer '.length).trim()
      : undefined;

  const rawToken =
    bearerToken ||
    event.authorizationEventObject?.systemIdToken ||
    event.authorizationEventObject?.userIdToken;

  if (!rawToken) {
    throw new StudioAuthError(
      'Missing authentication token in request header or authorizationEventObject.'
    );
  }

  // Use test verifier if registered
  if (customTokenVerifier) {
    const verified = await customTokenVerifier(rawToken);
    return verified.userId;
  }

  // Production verification: verify systemIdToken against invoked URL & service account
  const expectedServiceAccountEmail = process.env.GOOGLE_ADDON_SERVICE_ACCOUNT_EMAIL;
  if (!expectedServiceAccountEmail) {
    throw new StudioAuthError(
      'Server misconfiguration: GOOGLE_ADDON_SERVICE_ACCOUNT_EMAIL environment variable is not set.'
    );
  }

  const invokedUrl = `${getBaseUrl(req)}${req.originalUrl}`;
  const systemPayload = await verifyGoogleIdToken(rawToken, invokedUrl);

  if (!systemPayload.email_verified || systemPayload.email !== expectedServiceAccountEmail) {
    throw new StudioAuthError(
      `Service account mismatch: expected '${expectedServiceAccountEmail}', got '${String(systemPayload.email)}'`
    );
  }

  // If a separate userIdToken is provided, verify it to identify the user
  const userIdToken = event.authorizationEventObject?.userIdToken;
  if (userIdToken) {
    const addonClientId = process.env.GOOGLE_ADDON_CLIENT_ID;
    if (addonClientId) {
      const userPayload = await verifyGoogleIdToken(userIdToken, addonClientId);
      if (userPayload.sub) {
        return userPayload.sub;
      }
    }
  }

  // Fallback to sub claim on caller token
  if (!systemPayload.sub) {
    throw new StudioAuthError('Missing sub claim in token payload.');
  }

  return systemPayload.sub;
}

/**
 * Backward-compatible helper for verifying system token explicitly.
 */
export async function verifySystemIdToken(
  req: Request,
  event: RootEventObject
): Promise<TokenPayload> {
  const userId = await authenticateStudioRequest(req, event);
  return {
    sub: userId,
    iss: 'https://accounts.google.com',
    aud: `${getBaseUrl(req)}${req.originalUrl}`,
    email: process.env.GOOGLE_ADDON_SERVICE_ACCOUNT_EMAIL || '',
    email_verified: true,
  } as TokenPayload;
}

/**
 * Backward-compatible helper for verifying user token explicitly.
 */
export async function verifyAddonUserIdToken(
  event: RootEventObject
): Promise<string> {
  const rawToken =
    event.authorizationEventObject?.userIdToken ||
    event.authorizationEventObject?.systemIdToken;

  if (!rawToken) {
    throw new StudioAuthError('Missing user ID token in authorizationEventObject.');
  }

  if (customTokenVerifier) {
    const verified = await customTokenVerifier(rawToken);
    return verified.userId;
  }

  const addonClientId = process.env.GOOGLE_ADDON_CLIENT_ID;
  if (!addonClientId) {
    throw new StudioAuthError('Server misconfiguration: GOOGLE_ADDON_CLIENT_ID is not set.');
  }

  const payload = await verifyGoogleIdToken(rawToken, addonClientId);
  if (!payload.sub) {
    throw new StudioAuthError('Invalid user ID token: missing sub claim.');
  }

  return payload.sub;
}

/**
 * Verifies the OAuth 2.0 Web App ID token returned during `/auth/callback`.
 * Returns the user's immutable Google Account ID (`sub`).
 */
export async function verifyOAuthWebIdToken(idToken: string): Promise<string> {
  if (customTokenVerifier) {
    const verified = await customTokenVerifier(idToken);
    return verified.userId;
  }

  const oauthClientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  if (!oauthClientId) {
    throw new Error('Server misconfiguration: GOOGLE_OAUTH_CLIENT_ID is not set.');
  }

  const payload = await verifyGoogleIdToken(idToken, oauthClientId);
  if (!payload.sub) {
    throw new Error('Invalid OAuth ID token: missing sub claim.');
  }

  return payload.sub;
}
