import { Router, type Request, type Response } from 'express';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';
import { getBaseUrl } from '../utils/url.js';
import { getUserById, upsertUserTokens, updateCachedAccessToken } from '../db/index.js';
import { verifyOAuthWebIdToken } from './jwt.js';

export const authRouter = Router();

const SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/workspace.studio.trigger',
];

const CSRF_COOKIE_NAME = 'webhook_oauth_csrf';
const SESSION_COOKIE_NAME = 'webhook_oauth_session';

export interface OAuthTokenExchangeResult {
  refreshToken: string;
  accessToken: string;
  expiryDateMs: number;
  idToken: string;
}

export type TokenExchangeFn = (params: {
  code: string;
  codeVerifier: string;
  redirectUri: string;
}) => Promise<OAuthTokenExchangeResult>;

export type TokenRefreshFn = (refreshToken: string) => Promise<{
  accessToken: string;
  expiryDateMs: number;
}>;

let customTokenExchanger: TokenExchangeFn | null = null;
let customTokenRefresher: TokenRefreshFn | null = null;

export function setTokenExchangerForTesting(fn: TokenExchangeFn | null): void {
  customTokenExchanger = fn;
}

export function setTokenRefresherForTesting(fn: TokenRefreshFn | null): void {
  customTokenRefresher = fn;
}

function createOAuthClient(redirectUri?: string): OAuth2Client {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID ||
    'placeholder-oauth-client-id';
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET ||
    'placeholder-oauth-client-secret';
  return new OAuth2Client(clientId, clientSecret, redirectUri);
}

function base64UrlEncode(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function safeCompareStrings(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/**
 * Step 1: OAuth Interstitial Page (`GET /auth/start`)
 * Prevents silent login CSRF and session fixation by requiring an explicit POST
 * submission backed by a signed HttpOnly CSRF cookie before redirecting to Google.
 */
authRouter.get('/start', (req: Request, res: Response) => {
  const csrfToken = randomBytes(24).toString('hex');

  res.cookie(CSRF_COOKIE_NAME, csrfToken, {
    httpOnly: true,
    secure: req.secure || req.headers['x-forwarded-proto'] === 'https',
    sameSite: 'lax',
    signed: true,
    maxAge: 10 * 60 * 1000, // 10 minutes
  });

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Authorize Webhook Bridge — Google Workspace Studio</title>
  <style>
    body {
      font-family: 'Google Sans', Roboto, -apple-system, BlinkMacSystemFont, sans-serif;
      background: #f8f9fa;
      color: #202124;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
    }
    .card {
      background: #ffffff;
      border-radius: 12px;
      box-shadow: 0 4px 16px rgba(0,0,0,0.08);
      max-width: 440px;
      width: 90%;
      padding: 32px;
      text-align: center;
    }
    h1 {
      font-size: 20px;
      font-weight: 600;
      margin: 0 0 12px;
    }
    p {
      font-size: 14px;
      line-height: 1.5;
      color: #5f6368;
      margin: 0 0 24px;
    }
    .scope-box {
      background: #f1f3f4;
      border-radius: 8px;
      padding: 12px 16px;
      text-align: left;
      font-size: 13px;
      color: #3c4043;
      margin-bottom: 24px;
    }
    .btn {
      background: #1a73e8;
      color: #ffffff;
      border: none;
      border-radius: 6px;
      font-size: 14px;
      font-weight: 500;
      padding: 12px 24px;
      cursor: pointer;
      width: 100%;
    }
    .btn:hover {
      background: #1557b0;
    }
  </style>
</head>
<body>
  <div class="card">
    <h1>Connect Webhook Bridge</h1>
    <p>
      To forward incoming webhook events to your Google Workspace Studio workflows asynchronously,
      this add-on requires offline permission to trigger flows on your behalf.
    </p>
    <div class="scope-box">
      <strong>Requested Permissions:</strong>
      <ul>
        <li>Verify your Google Account ID (<code>openid</code>)</li>
        <li>Fire Workspace Studio starters (<code>workspace.studio.trigger</code>)</li>
      </ul>
    </div>
    <form method="POST" action="/auth/initiate">
      <input type="hidden" name="csrfToken" value="${csrfToken}" />
      <button type="submit" class="btn">Continue to Google Sign-In</button>
    </form>
  </div>
</body>
</html>`);
});

/**
 * Step 2: Initiate OAuth Flow (`POST /auth/initiate`)
 * Verifies CSRF token, generates OAuth state + PKCE challenge, and redirects to Google.
 */
authRouter.post('/initiate', (req: Request, res: Response) => {
  const cookieCsrf = req.signedCookies?.[CSRF_COOKIE_NAME];
  const formCsrf = req.body?.csrfToken;

  if (!cookieCsrf || !formCsrf || !safeCompareStrings(String(cookieCsrf), String(formCsrf))) {
    res.status(403).send('Invalid or expired CSRF token. Please reload the authorization page.');
    return;
  }

  res.clearCookie(CSRF_COOKIE_NAME);

  const state = randomBytes(24).toString('hex');
  const codeVerifier = base64UrlEncode(randomBytes(32));
  const codeChallenge = base64UrlEncode(
    createHash('sha256').update(codeVerifier).digest()
  );

  const sessionPayload = JSON.stringify({ state, codeVerifier });
  res.cookie(SESSION_COOKIE_NAME, sessionPayload, {
    httpOnly: true,
    secure: req.secure || req.headers['x-forwarded-proto'] === 'https',
    sameSite: 'lax',
    signed: true,
    maxAge: 10 * 60 * 1000,
  });

  const redirectUri = `${getBaseUrl(req)}/auth/callback`;
  const oauthClient = createOAuthClient(redirectUri);

  const authUrl = oauthClient.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
    state,
    code_challenge: codeChallenge,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    code_challenge_method: 'S256' as any,
  });

  res.redirect(302, authUrl);
});

/**
 * Step 3: OAuth Callback (`GET /auth/callback`)
 * Verifies state parameter, exchanges authorization code + PKCE verifier for tokens,
 * extracts immutable `user_id` (`sub` claim), and persists `refresh_token`, `access_token`,
 * and `access_token_expiry` in SQLite.
 */
authRouter.get('/callback', async (req: Request, res: Response) => {
  try {
    const rawSession = req.signedCookies?.[SESSION_COOKIE_NAME];
    if (!rawSession) {
      res.status(400).send('OAuth session expired or missing. Please start authorization again.');
      return;
    }

    const { state: expectedState, codeVerifier } = JSON.parse(rawSession) as {
      state: string;
      codeVerifier: string;
    };

    const queryState = String(req.query.state || '');
    const code = String(req.query.code || '');

    if (!expectedState || !queryState || !safeCompareStrings(expectedState, queryState)) {
      res.status(403).send('OAuth state mismatch.');
      return;
    }

    if (!code) {
      res.status(400).send('Missing authorization code.');
      return;
    }

    res.clearCookie(SESSION_COOKIE_NAME);

    const redirectUri = `${getBaseUrl(req)}/auth/callback`;

    let tokenData: OAuthTokenExchangeResult;
    if (customTokenExchanger) {
      tokenData = await customTokenExchanger({ code, codeVerifier, redirectUri });
    } else {
      const oauthClient = createOAuthClient(redirectUri);
      const { tokens } = await oauthClient.getToken({
        code,
        codeVerifier,
      });

      if (!tokens.refresh_token) {
        throw new Error(
          'Google did not return a refresh_token. Ensure access_type=offline and prompt=consent are set.'
        );
      }
      if (!tokens.id_token) {
        throw new Error('Google did not return an id_token. Ensure openid scope is requested.');
      }

      tokenData = {
        refreshToken: tokens.refresh_token,
        accessToken: tokens.access_token || '',
        expiryDateMs: tokens.expiry_date || Date.now() + 3600 * 1000,
        idToken: tokens.id_token,
      };
    }

    // Verify OAuth web app ID token against OAUTH_CLIENT_ID to obtain stable user_id (sub)
    const userId = await verifyOAuthWebIdToken(tokenData.idToken);

    upsertUserTokens({
      userId,
      refreshToken: tokenData.refreshToken,
      accessToken: tokenData.accessToken,
      accessTokenExpiry: tokenData.expiryDateMs,
    });

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Authorization Complete</title>
  <style>
    body {
      font-family: 'Google Sans', Roboto, sans-serif;
      background: #f8f9fa;
      color: #202124;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
    }
    .card {
      background: #fff;
      border-radius: 12px;
      padding: 32px;
      box-shadow: 0 4px 16px rgba(0,0,0,0.08);
      text-align: center;
      max-width: 400px;
    }
    h1 { color: #137333; font-size: 20px; margin: 0 0 12px; }
    p { color: #5f6368; font-size: 14px; margin: 0 0 20px; }
    button {
      background: #1a73e8;
      color: #fff;
      border: none;
      border-radius: 6px;
      padding: 10px 20px;
      cursor: pointer;
    }
  </style>
</head>
<body>
  <div class="card">
    <h1>✓ Account Authorized</h1>
    <p>Your long-lived credentials have been saved. You can close this window and return to Google Workspace Studio.</p>
    <button onclick="window.close()">Close Window</button>
  </div>
  <script>
    setTimeout(() => { window.close(); }, 1200);
  </script>
</body>
</html>`);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error during OAuth callback';
    res.status(500).send(`OAuth Authorization Failed: ${message}`);
  }
});

/**
 * Returns a valid Google OAuth access token for `userId`.
 * - If a cached `access_token` is present in SQLite and expires more than 60 seconds
 *   in the future, returns the cached token immediately without an HTTP round-trip.
 * - Otherwise, exchanges the stored `refresh_token` for a fresh access token and
 *   persists the new `access_token` + `access_token_expiry` in SQLite.
 */
export async function getValidAccessToken(userId: string): Promise<string> {
  const user = getUserById(userId);
  if (!user || !user.refreshToken) {
    throw new Error(`No stored OAuth credentials found for user_id=${userId}`);
  }

  const now = Date.now();
  const safetyMarginMs = 60 * 1000; // 60 seconds buffer

  if (
    user.accessToken &&
    user.accessTokenExpiry &&
    user.accessTokenExpiry > now + safetyMarginMs
  ) {
    return user.accessToken;
  }

  // Token expired or not cached — fetch fresh access token using refresh_token
  let refreshed: { accessToken: string; expiryDateMs: number };
  if (customTokenRefresher) {
    refreshed = await customTokenRefresher(user.refreshToken);
  } else {
    const oauthClient = createOAuthClient();
    oauthClient.setCredentials({ refresh_token: user.refreshToken });
    const response = await oauthClient.refreshAccessToken();
    const creds = response.credentials;
    if (!creds.access_token) {
      throw new Error('Failed to refresh access token from Google.');
    }
    refreshed = {
      accessToken: creds.access_token,
      expiryDateMs: creds.expiry_date || Date.now() + 3600 * 1000,
    };
  }

  updateCachedAccessToken(userId, refreshed.accessToken, refreshed.expiryDateMs);
  return refreshed.accessToken;
}
