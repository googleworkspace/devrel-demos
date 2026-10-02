import express, { Router, type Request, type Response, type NextFunction } from 'express';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { FireTriggerRequest } from '../types.js';
import {
  getActiveSubscriptionWithUser,
  getActiveSubscriptionWithUserByInstanceId,
  listSecretsByInstanceId,
  deleteSubscriptionByTriggerId,
} from '../db/index.js';
import { getValidAccessToken } from '../auth/oauth.js';
import { hashWebhookSecret } from '../utils/url.js';

export const webhookRouter = Router();

export type FetchFn = typeof fetch;
let customFetch: FetchFn | null = null;

export function setStudioFetchForTesting(fn: FetchFn | null): void {
  customFetch = fn;
}

/**
 * Constant-time string comparison to prevent timing attacks on webhook secrets.
 */
function constantTimeCompare(provided: string, expected: string): boolean {
  const bufA = Buffer.from(provided, 'utf8');
  const bufB = Buffer.from(expected, 'utf8');
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/**
 * Extracts secret from `Authorization: ApiKey <secret>` or `X-Webhook-Secret: <secret>` header.
 */
function extractProvidedSecret(req: Request): string | null {
  const customHeader = req.headers['x-webhook-secret'];
  if (typeof customHeader === 'string' && customHeader.trim()) {
    return customHeader.trim();
  }

  const authHeader = req.headers.authorization;
  const raw = Array.isArray(authHeader) ? authHeader[0] : authHeader;
  if (!raw) {
    return null;
  }

  const match = raw.match(/^ApiKey\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

/**
 * Strict 1 KB (1024 bytes) raw body parser.
 */
const rawBodyParser = express.raw({
  type: '*/*',
  limit: '1kb',
});

/**
 * Public Webhook Ingestion Pipeline (`POST /webhook/:identifier`)
 *
 * Demo Walkthrough Pipeline (5 clean steps):
 * 1. Subscription Lookup: Resolves active workflow by `triggerId` or `instanceId`.
 * 2. Security Verification: Constant-time check on `X-Webhook-Secret` if required.
 * 3. Access Token Caching: Reuses cached Google OAuth access token if unexpired.
 * 4. Request Envelope: Formats Google Workspace Studio `FireTriggerRequest`.
 * 5. Upstream Dispatch: Posts to Studio `notifyUri` and relays status / rate limits.
 */
webhookRouter.post(
  '/:identifier',
  (req: Request, res: Response, next: NextFunction) => {
    rawBodyParser(req, res, (err: unknown) => {
      if (err && typeof err === 'object' && 'type' in err && err.type === 'entity.too.large') {
        res.status(413).json({
          error: 'Payload Too Large: Webhook payload exceeds maximum size of 1 KB (1024 bytes).',
        });
        return;
      }
      if (err) {
        next(err);
        return;
      }
      next();
    });
  },
  async (req: Request, res: Response) => {
    const identifier = String(req.params.identifier || '');

    // Guard against payloads exceeding 1024 bytes
    const rawBuffer: Buffer = Buffer.isBuffer(req.body)
      ? req.body
      : Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? ''), 'utf8');

    if (rawBuffer.byteLength > 1024) {
      res.status(413).json({
        error: 'Payload Too Large: Webhook payload exceeds maximum size of 1 KB (1024 bytes).',
      });
      return;
    }

    const rawPayloadString = rawBuffer.toString('utf8');

    // Step 1: Lookup active subscription by triggerId OR instanceId
    const record =
      getActiveSubscriptionWithUser(identifier) ||
      getActiveSubscriptionWithUserByInstanceId(identifier);

    if (!record) {
      res.status(404).json({
        error: `No active webhook subscription found for '${identifier}'. Ensure the workflow is enabled in Workspace Studio.`,
      });
      return;
    }

    const { subscription, user } = record;
    const triggerId = subscription.triggerId;

    // Step 2: Enforce optional API key security
    if (subscription.requireApiKey) {
      const providedSecret = extractProvidedSecret(req);
      if (!providedSecret) {
        res.status(401).json({
          error: 'Unauthorized: Missing secret. Expected X-Webhook-Secret header or Authorization: ApiKey <secret>.',
        });
        return;
      }

      const providedHash = hashWebhookSecret(providedSecret);
      const storedSecrets = listSecretsByInstanceId(subscription.instanceId);

      let matched = false;
      for (const sec of storedSecrets) {
        if (constantTimeCompare(providedHash, sec.secretHash)) {
          matched = true;
          break;
        }
      }

      if (!matched) {
        res.status(401).json({
          error: 'Unauthorized: Invalid API key secret.',
        });
        return;
      }
    }

    // Step 3: Retrieve valid OAuth access token (reuses SQLite cached token if unexpired)
    let accessToken: string;
    try {
      accessToken = await getValidAccessToken(user.userId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to obtain user access token';
      res.status(502).json({
        error: `OAuth token refresh failed for workflow owner: ${msg}`,
      });
      return;
    }

    // Step 4: Construct Studio FireTriggerRequest
    const requestId = randomUUID();
    const fireRequest: FireTriggerRequest = {
      name: `triggers/${triggerId}`,
      outputs: {
        rawPayload: {
          stringValues: [rawPayloadString],
        },
      },
      log: {
        textFormatElements: [
          {
            text: `Webhook payload received (${rawBuffer.byteLength} bytes) and forwarded to workflow.`,
          },
        ],
      },
      requestId,
    };

    // Step 5: Dispatch to Workspace Studio notifyUri and pass through status/errors
    const fetchImpl = customFetch || fetch;
    let studioRes: globalThis.Response;
    try {
      studioRes = await fetchImpl(subscription.notifyUri, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(fireRequest),
      });
    } catch (networkErr) {
      const msg = networkErr instanceof Error ? networkErr.message : 'Network error';
      res.status(502).json({
        error: `Failed to reach Google Workspace Studio notifyUri: ${msg}`,
      });
      return;
    }

    // Relay Retry-After header if Studio sent one (e.g. on 429 rate limits or 503)
    const retryAfter = studioRes.headers.get('retry-after');
    if (retryAfter) {
      res.setHeader('Retry-After', retryAfter);
    }

    const upstreamText = await studioRes.text();
    let upstreamJson: unknown = null;
    if (upstreamText) {
      try {
        upstreamJson = JSON.parse(upstreamText);
      } catch {
        // Leave as string if not JSON
      }
    }

    // Handle 404: decommission trigger in SQLite and notify caller
    if (studioRes.status === 404) {
      deleteSubscriptionByTriggerId(triggerId);
      res.status(404).json(
        upstreamJson || {
          error: `Workspace Studio returned 404 Not Found for trigger '${triggerId}'. Subscription has been decommissioned.`,
          upstreamResponse: upstreamText || undefined,
        }
      );
      return;
    }

    // Pass through upstream error statuses (429, 400, 500, etc.)
    if (!studioRes.ok) {
      res.status(studioRes.status).json(
        upstreamJson || {
          error: `Workspace Studio API returned HTTP ${studioRes.status}`,
          upstreamResponse: upstreamText || undefined,
        }
      );
      return;
    }

    // 200 OK
    res.status(200).json({
      status: 'ok',
      instanceId: subscription.instanceId,
      triggerId,
      requestId,
      bytes: rawBuffer.byteLength,
      studioResponse: upstreamJson ?? {},
    });
  }
);
