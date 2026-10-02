import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { getDb, setDbForTesting, getUserById, getActiveSubscriptionWithUser } from '../src/db/index.js';
import { setTokenVerifierForTesting } from '../src/auth/jwt.js';
import {
  setTokenExchangerForTesting,
  setTokenRefresherForTesting,
} from '../src/auth/oauth.js';
import { setStudioFetchForTesting } from '../src/webhook/routes.js';

describe('Webhook Bridge Studio Add-on Integration Tests', () => {
  const app = createApp();
  const TEST_USER_ID = 'google-user-sub-999888777';

  beforeEach(() => {
    // Initialize fresh in-memory SQLite database for each test
    const memoryDb = getDb(':memory:');
    setDbForTesting(memoryDb);

    // Mock Google ID token verifier
    setTokenVerifierForTesting(async (token: string) => {
      if (token === 'valid-studio-jwt') {
        return { userId: TEST_USER_ID };
      }
      if (token === 'unauth-studio-jwt') {
        return { userId: 'unauth-user-sub-000' };
      }
      throw new Error('Invalid JWT');
    });
  });

  it('1. OAuth Web App: enforces CSRF on interstitial page and persists refresh_token + access_token + expiry', async () => {
    // Step 1: GET /auth/start renders interstitial page and sets signed CSRF cookie
    const startRes = await request(app)
      .get('/auth/start')
      .set('X-Forwarded-Proto', 'https')
      .set('X-Forwarded-Host', 'bridge.example.com');

    expect(startRes.status).toBe(200);
    expect(startRes.text).toContain('Connect Webhook Bridge');

    const cookies = startRes.headers['set-cookie'];
    expect(cookies).toBeDefined();

    // Extract csrfToken from HTML hidden input
    const match = startRes.text.match(/name="csrfToken"\s+value="([^"]+)"/);
    expect(match).not.toBeNull();
    const csrfToken = match![1];

    // Attempt POST /auth/initiate with WRONG CSRF token -> 403 Forbidden
    const badInitiate = await request(app)
      .post('/auth/initiate')
      .set('Cookie', cookies)
      .type('form')
      .send({ csrfToken: 'wrong-csrf-token' });
    expect(badInitiate.status).toBe(403);

    // Step 2: POST /auth/initiate with valid CSRF token -> 302 Redirect to Google OAuth
    const initiateRes = await request(app)
      .post('/auth/initiate')
      .set('Cookie', cookies)
      .set('X-Forwarded-Proto', 'https')
      .set('X-Forwarded-Host', 'bridge.example.com')
      .type('form')
      .send({ csrfToken });

    expect(initiateRes.status).toBe(302);
    const location = initiateRes.headers.location;
    expect(location).toContain('accounts.google.com/o/oauth2/v2/auth');
    expect(location).toContain('scope=openid%20https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fworkspace.studio.trigger');
    expect(location).not.toContain('email'); // Verify email scope is NOT requested

    const sessionCookies = initiateRes.headers['set-cookie'];
    const stateMatch = location.match(/[?&]state=([^&]+)/);
    expect(stateMatch).not.toBeNull();
    const oauthState = stateMatch![1];

    // Step 3: GET /auth/callback exchanges code and stores refresh_token + access_token + expiry
    const futureExpiry = Date.now() + 3600 * 1000;
    setTokenExchangerForTesting(async ({ code }) => {
      expect(code).toBe('mock-auth-code-123');
      return {
        refreshToken: 'refresh-token-xyz',
        accessToken: 'initial-cached-access-token',
        expiryDateMs: futureExpiry,
        idToken: 'valid-studio-jwt',
      };
    });

    const callbackRes = await request(app)
      .get(`/auth/callback?code=mock-auth-code-123&state=${oauthState}`)
      .set('Cookie', sessionCookies);

    expect(callbackRes.status).toBe(200);
    expect(callbackRes.text).toContain('Account Authorized');

    // Verify user record in SQLite
    const savedUser = getUserById(TEST_USER_ID);
    expect(savedUser).toBeDefined();
    expect(savedUser?.userId).toBe(TEST_USER_ID);
    expect(savedUser?.refreshToken).toBe('refresh-token-xyz');
    expect(savedUser?.accessToken).toBe('initial-cached-access-token');
    expect(savedUser?.accessTokenExpiry).toBe(futureExpiry);
  });

  it('2. Starter UI (/studio/on-config & /studio/on-toggle-api-key): materializes baseUrl and updates UI dynamically', async () => {
    // Unauthenticated user config card
    const unauthRes = await request(app)
      .post('/studio/on-config')
      .set('X-Forwarded-Proto', 'https')
      .set('X-Forwarded-Host', 'my-webhook-host.run.app')
      .send({
        authorizationEventObject: { systemIdToken: 'unauth-studio-jwt' },
        commonEventObject: {},
      });

    expect(unauthRes.status).toBe(200);
    const unauthCardStr = JSON.stringify(unauthRes.body);
    expect(unauthCardStr).toContain('https://my-webhook-host.run.app/auth/start');
    expect(unauthCardStr).toContain('Account Authorization Required');

    // Dynamic API key toggle: user enables requireApiKey switch
    const toggleRes = await request(app)
      .post('/studio/on-toggle-api-key')
      .set('X-Forwarded-Proto', 'https')
      .set('X-Forwarded-Host', 'my-webhook-host.run.app')
      .send({
        authorizationEventObject: { systemIdToken: 'unauth-studio-jwt' },
        commonEventObject: {
          formInputs: {
            instanceId: { stringInputs: { value: ['inst-uuid-1'] } },
            requireApiKey: { stringInputs: { value: ['true'] } },
          },
        },
      });

    expect(toggleRes.status).toBe(200);
    const replaceSection = toggleRes.body.action?.modifyOperations?.[0]?.replaceSection;
    expect(replaceSection).toBeDefined();
    expect(replaceSection.id).toBe('api_key_section');

    const sectionStr = JSON.stringify(replaceSection);
    expect(sectionStr).toContain('whsec_');
    expect(sectionStr).toContain('Regenerate Secret');
  });

  it('3. Lifecycle & Webhook Dispatch: enforces 1 KB limit, API key, cached access_token reuse, and upstream error pass-through', async () => {
    // 3a. Attempt triggerCreation before authorizing -> returns returnElementErrorAction
    const failManage = await request(app)
      .post('/studio/on-manage')
      .send({
        authorizationEventObject: { systemIdToken: 'valid-studio-jwt' },
        workflow: {
          triggerCreation: {
            triggerId: 'trig-abc-123',
            notifyUri: 'https://workspacestudio.googleapis.com/v1/triggers/trig-abc-123:fire',
            inputs: {
              instanceId: { stringValues: ['inst-abc'] },
            },
          },
        },
      });

    expect(failManage.status).toBe(200);
    expect(
      failManage.body.hostAppAction?.workflowAction?.returnElementErrorAction
    ).toBeDefined();

    // 3b. Seed user with valid cached access token expiring in 1 hour
    const initialExpiry = Date.now() + 3600 * 1000;
    const db = getDb();
    const { upsertUserTokens } = await import('../src/db/index.js');
    upsertUserTokens(
      {
        userId: TEST_USER_ID,
        refreshToken: 'valid-refresh-token',
        accessToken: 'cached-token-valid-111',
        accessTokenExpiry: initialExpiry,
      },
      db
    );

    // 3c. Enable workflow with API key required
    const successManage = await request(app)
      .post('/studio/on-manage')
      .send({
        authorizationEventObject: { systemIdToken: 'valid-studio-jwt' },
        workflow: {
          triggerCreation: {
            triggerId: 'trig-abc-123',
            notifyUri: 'https://workspacestudio.googleapis.com/v1/triggers/trig-abc-123:fire',
            inputs: {
              instanceId: { stringValues: ['inst-abc'] },
              requireApiKey: { booleanValues: [true] },
              apiKey: { stringValues: ['whsec_testsecret999'] },
            },
          },
        },
      });

    expect(successManage.status).toBe(200);
    expect(successManage.body).toEqual({});

    // Verify active config card now displays materialized webhook URL
    const activeConfigRes = await request(app)
      .post('/studio/on-config')
      .set('X-Forwarded-Proto', 'https')
      .set('X-Forwarded-Host', 'prod-bridge.example.org')
      .send({
        authorizationEventObject: { systemIdToken: 'valid-studio-jwt' },
        workflow: {
          elementConfiguration: {
            inputs: {
              instanceId: { stringValues: ['inst-abc'] },
            },
          },
        },
      });

    expect(JSON.stringify(activeConfigRes.body)).toContain(
      'https://prod-bridge.example.org/webhook/trig-abc-123'
    );

    // 3d. Test 1 KB payload size limit -> 413 Payload Too Large
    const oversizedPayload = 'x'.repeat(1025);
    const sizeErrRes = await request(app)
      .post('/webhook/trig-abc-123')
      .set('X-Webhook-Secret', 'whsec_testsecret999')
      .set('Content-Type', 'text/plain')
      .send(oversizedPayload);

    expect(sizeErrRes.status).toBe(413);

    // 3e. Test API Key enforcement -> 401 Unauthorized on wrong secret
    const authErrRes = await request(app)
      .post('/webhook/trig-abc-123')
      .set('X-Webhook-Secret', 'wrong-secret')
      .send('{"hello":"world"}');

    expect(authErrRes.status).toBe(401);

    // 3f. Test successful webhook dispatch with CACHED access token (0 token refreshes!)
    let refreshCallCount = 0;
    setTokenRefresherForTesting(async () => {
      refreshCallCount++;
      return {
        accessToken: `refreshed-token-${refreshCallCount}`,
        expiryDateMs: Date.now() + 3600 * 1000,
      };
    });

    let lastAuthorizationHeader = '';
    let lastStudioPayload: unknown = null;

    setStudioFetchForTesting(async (_url, init) => {
      const headers = init?.headers as Record<string, string>;
      lastAuthorizationHeader = headers.Authorization;
      lastStudioPayload = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const okRes = await request(app)
      .post('/webhook/trig-abc-123')
      .set('X-Webhook-Secret', 'whsec_testsecret999')
      .set('Content-Type', 'application/json')
      .send('{"event":"invoice.paid","amount":99}');

    expect(okRes.status).toBe(200);
    expect(refreshCallCount).toBe(0); // Cached token was used!
    expect(lastAuthorizationHeader).toBe('Bearer cached-token-valid-111');
    expect(lastStudioPayload).toMatchObject({
      name: 'triggers/trig-abc-123',
      outputs: {
        rawPayload: {
          stringValues: ['{"event":"invoice.paid","amount":99}'],
        },
      },
    });

    // 3g. Expire the cached token in SQLite and verify next webhook refreshes + updates DB
    upsertUserTokens(
      {
        userId: TEST_USER_ID,
        refreshToken: 'valid-refresh-token',
        accessToken: 'expired-token-000',
        accessTokenExpiry: Date.now() - 5000, // Expired 5s ago
      },
      db
    );

    const refreshedRes = await request(app)
      .post('/webhook/trig-abc-123')
      .set('X-Webhook-Secret', 'whsec_testsecret999')
      .send('{"event":"second"}');

    expect(refreshedRes.status).toBe(200);
    expect(refreshCallCount).toBe(1); // Refreshed exactly once
    expect(lastAuthorizationHeader).toBe('Bearer refreshed-token-1');

    // Subsequent call should reuse the newly refreshed token without refreshing again
    await request(app)
      .post('/webhook/trig-abc-123')
      .set('X-Webhook-Secret', 'whsec_testsecret999')
      .send('{"event":"third"}');
    expect(refreshCallCount).toBe(1); // Still 1!

    // 3h. Test Upstream Error Pass-Through (Studio returns 429 Too Many Requests with Retry-After)
    setStudioFetchForTesting(async () => {
      return new Response(
        JSON.stringify({
          error: {
            code: 429,
            message: 'Quota exceeded for quota metric Starter requests per minute per user',
            status: 'RESOURCE_EXHAUSTED',
          },
        }),
        {
          status: 429,
          headers: {
            'Content-Type': 'application/json',
            'Retry-After': '45',
          },
        }
      );
    });

    const rateLimitRes = await request(app)
      .post('/webhook/trig-abc-123')
      .set('X-Webhook-Secret', 'whsec_testsecret999')
      .send('{"event":"burst"}');

    expect(rateLimitRes.status).toBe(429);
    expect(rateLimitRes.headers['retry-after']).toBe('45');
    expect(rateLimitRes.body.error?.status).toBe('RESOURCE_EXHAUSTED');

    // 3i. Test Upstream 404 Decommissioning (Studio returns 404 Not Found -> deletes subscription from DB)
    setStudioFetchForTesting(async () => {
      return new Response(
        JSON.stringify({
          error: {
            code: 404,
            message: 'Requested entity was not found.',
            status: 'NOT_FOUND',
          },
        }),
        {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    });

    const notFoundRes = await request(app)
      .post('/webhook/trig-abc-123')
      .set('X-Webhook-Secret', 'whsec_testsecret999')
      .send('{"event":"after_delete"}');

    expect(notFoundRes.status).toBe(404);
    // Verify subscription was removed from SQLite
    expect(getActiveSubscriptionWithUser('trig-abc-123')).toBeUndefined();
  });
});
