import { Router, type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import type { ModifyOperation, RootEventObject, StudioRenderActions } from '../types.js';
import {
  authenticateStudioRequest,
  verifySystemIdToken,
  verifyAddonUserIdToken,
  StudioAuthError,
} from '../auth/jwt.js';
import {
  getUserById,
  getActiveSubscriptionByInstanceId,
  createSubscription,
  deleteSubscriptionByTriggerId,
  listSecretsByInstanceId,
  addSecretForInstance,
  deleteSecretById,
} from '../db/index.js';
import {
  getBaseUrl,
  generateWebhookSecret,
  hashWebhookSecret,
  formatSecretLabel,
} from '../utils/url.js';
import { buildConfigCard, buildApiKeySection, buildEndpointSection } from './cards.js';

export const studioRouter = Router();

function handleStudioError(err: unknown, res: Response, fallbackMsg: string): void {
  if (err instanceof StudioAuthError) {
    res.status(403).json({ error: err.message });
    return;
  }
  const msg = err instanceof Error ? err.message : fallbackMsg;
  res.status(400).json({ error: msg });
}

/**
 * Helper to extract a string input value from either live `formInputs` or
 * saved `elementConfiguration.inputs`.
 */
function getStringInput(
  event: RootEventObject,
  fieldName: string
): string | undefined {
  // 1. Live form input
  const formVal = (
    event.commonEventObject?.formInputs as Record<
      string,
      { stringInputs?: { value?: string[] } }
    > | undefined
  )?.[fieldName]?.stringInputs?.value?.[0];
  if (formVal !== undefined && formVal !== '') {
    return formVal;
  }

  // 2. Saved element configuration input
  const savedVal =
    event.workflow?.elementConfiguration?.inputs?.[fieldName]?.stringValues?.[0];
  if (savedVal !== undefined && savedVal !== '') {
    return savedVal;
  }

  return undefined;
}

/**
 * Helper to extract a boolean input value from either live `formInputs` or
 * saved `elementConfiguration.inputs`.
 */
function getBooleanInput(
  event: RootEventObject,
  fieldName: string
): boolean | undefined {
  const formInputs = event.commonEventObject?.formInputs as
    | Record<string, { stringInputs?: { value?: string[] } }>
    | undefined;

  if (formInputs && fieldName in formInputs) {
    const values = formInputs[fieldName]?.stringInputs?.value || [];
    return values.includes('true');
  }

  const savedBool =
    event.workflow?.elementConfiguration?.inputs?.[fieldName]?.booleanValues?.[0];
  if (savedBool !== undefined) {
    return savedBool;
  }

  const savedStr =
    event.workflow?.elementConfiguration?.inputs?.[fieldName]?.stringValues?.[0];
  if (savedStr !== undefined) {
    return savedStr === 'true';
  }

  return undefined;
}

/**
 * Endpoint 1: Starter Configuration Card (`POST /studio/on-config`)
 * Renders the configuration UI showing:
 * - Whether the user has authorized offline OAuth access
 * - The immediate webhook URL (`https://{host}/webhook/{instanceId}`) and `curl` example
 * - The API key security toggle and list of stored (hashed) secrets
 */
studioRouter.post('/on-config', async (req: Request, res: Response) => {
  try {
    const event = req.body as RootEventObject;
    const userId = await authenticateStudioRequest(req, event);
    const baseUrl = getBaseUrl(req);

    const userRecord = getUserById(userId);
    const isAuthorized = Boolean(userRecord?.refreshToken);

    const instanceId = getStringInput(event, 'instanceId') || randomUUID();
    const activeSubscription = getActiveSubscriptionByInstanceId(instanceId);
    const storedSecrets = listSecretsByInstanceId(instanceId);

    const requireApiKey =
      getBooleanInput(event, 'requireApiKey') ??
      activeSubscription?.requireApiKey ??
      false;

    const card = buildConfigCard({
      baseUrl,
      instanceId,
      triggerId: activeSubscription?.triggerId,
      isAuthorized,
      requireApiKey,
      secrets: storedSecrets,
    });

    const responsePayload: StudioRenderActions = {
      action: {
        navigations: [{ pushCard: card }],
      },
    };

    res.json(responsePayload);
  } catch (err) {
    handleStudioError(err, res, 'Error building config card');
  }
});

/**
 * Endpoint 2: Dynamic API Key Toggle (`POST /studio/on-toggle-api-key`)
 * Invoked when the user toggles the `requireApiKey` switch.
 * Uses `modifyOperations` to incrementally replace `webhook_endpoint_section`
 * and `api_key_section` without persisting `requireApiKey` to `subscriptions`
 * until the user saves/confirms in Studio.
 */
studioRouter.post('/on-toggle-api-key', async (req: Request, res: Response) => {
  try {
    const event = req.body as RootEventObject;
    const userId = await authenticateStudioRequest(req, event);
    const baseUrl = getBaseUrl(req);

    const instanceId = getStringInput(event, 'instanceId');
    const requireApiKey = getBooleanInput(event, 'requireApiKey') ?? false;
    let storedSecrets = instanceId ? listSecretsByInstanceId(instanceId) : [];

    let newlyCreatedSecret: string | null = null;
    if (requireApiKey && instanceId && storedSecrets.length === 0) {
      const rawSecret = generateWebhookSecret();
      const secretHash = hashWebhookSecret(rawSecret);
      const label = formatSecretLabel(rawSecret);
      addSecretForInstance({
        secretId: randomUUID(),
        instanceId,
        userId,
        label,
        secretHash,
      });
      storedSecrets = listSecretsByInstanceId(instanceId);
      newlyCreatedSecret = rawSecret;
    }

    const modifyOperations: ModifyOperation[] = [
      {
        replaceSection: buildApiKeySection({
          baseUrl,
          requireApiKey,
          secrets: storedSecrets,
          newlyCreatedSecret,
        }),
      },
    ];

    if (instanceId) {
      modifyOperations.push({
        replaceSection: buildEndpointSection({
          baseUrl,
          instanceId,
          requireApiKey,
        }),
      });
    }

    const responsePayload: StudioRenderActions = {
      action: {
        modifyOperations,
      },
    };

    res.json(responsePayload);
  } catch (err) {
    handleStudioError(err, res, 'Error updating API key section');
  }
});

/**
 * Endpoint 3: Add New Secret (`POST /studio/on-add-secret`)
 * Immediately generates a new secret, stores its SHA-256 hash + label in SQLite
 * tied to `instanceId`, and incrementally updates `api_key_section` via
 * `modifyOperations` to show the plaintext secret ONCE so the user can copy it.
 */
studioRouter.post('/on-add-secret', async (req: Request, res: Response) => {
  try {
    const event = req.body as RootEventObject;
    const userId = await authenticateStudioRequest(req, event);
    const baseUrl = getBaseUrl(req);

    const instanceId = getStringInput(event, 'instanceId') || randomUUID();
    const customLabel = getStringInput(event, 'newSecretLabel');

    const rawSecret = generateWebhookSecret();
    const secretHash = hashWebhookSecret(rawSecret);
    const label = formatSecretLabel(rawSecret, customLabel);

    addSecretForInstance({
      secretId: randomUUID(),
      instanceId,
      userId,
      label,
      secretHash,
    });

    const storedSecrets = listSecretsByInstanceId(instanceId);

    const responsePayload: StudioRenderActions = {
      action: {
        modifyOperations: [
          {
            replaceSection: buildEndpointSection({
              baseUrl,
              instanceId,
              requireApiKey: true,
            }),
          },
          {
            replaceSection: buildApiKeySection({
              baseUrl,
              requireApiKey: true,
              secrets: storedSecrets,
              newlyCreatedSecret: rawSecret,
            }),
          },
        ],
      },
    };

    res.json(responsePayload);
  } catch (err) {
    handleStudioError(err, res, 'Error adding webhook secret');
  }
});

/**
 * Endpoint 4: Delete / Revoke Secret (`POST /studio/on-delete-secret`)
 * Immediately removes the specified secret hash from SQLite and incrementally
 * updates `api_key_section` via `modifyOperations`.
 */
studioRouter.post('/on-delete-secret', async (req: Request, res: Response) => {
  try {
    const event = req.body as RootEventObject;
    const userId = await authenticateStudioRequest(req, event);
    const baseUrl = getBaseUrl(req);

    const instanceId = getStringInput(event, 'instanceId');
    const secretId = event.commonEventObject?.parameters?.secretId;

    if (instanceId && secretId) {
      deleteSecretById({
        secretId,
        instanceId,
        userId,
      });
    }

    const storedSecrets = instanceId ? listSecretsByInstanceId(instanceId) : [];

    const responsePayload: StudioRenderActions = {
      action: {
        modifyOperations: [
          {
            replaceSection: buildApiKeySection({
              baseUrl,
              requireApiKey: true,
              secrets: storedSecrets,
            }),
          },
        ],
      },
    };

    res.json(responsePayload);
  } catch (err) {
    handleStudioError(err, res, 'Error deleting webhook secret');
  }
});

/**
 * Endpoint 5: Lifecycle Management (`POST /studio/on-manage`)
 * Handles `triggerCreation` (when a flow is enabled or reconfigured) and
 * `triggerDeletion` (when a flow is disabled, deleted, or superseded by a reconfigured trigger).
 */
studioRouter.post('/on-manage', async (req: Request, res: Response) => {
  try {
    const event = req.body as RootEventObject;
    // Always verify systemIdToken first to prove the request came from Google
    await verifySystemIdToken(req, event);

    const triggerCreation = event.workflow?.triggerCreation;
    const triggerDeletion = event.workflow?.triggerDeletion;

    if (triggerCreation) {
      const userId = await verifyAddonUserIdToken(event);
      const userRecord = getUserById(userId);

      // Reject activation if user has not completed the offline OAuth flow
      if (!userRecord || !userRecord.refreshToken) {
        const errorResponse: StudioRenderActions = {
          hostAppAction: {
            workflowAction: {
              returnElementErrorAction: {
                developerErrorMessage: `User ${userId} attempted to enable webhook starter without stored OAuth refresh_token.`,
                errorActionability: 'ACTIONABLE',
                retryability: 'NOT_RETRYABLE',
                errorLog: {
                  textFormatElements: [
                    {
                      text: 'Please open the starter configuration card and click "Authorize Account" before enabling this workflow.',
                    },
                  ],
                },
              },
            },
          },
        };
        res.json(errorResponse);
        return;
      }

      const triggerId = triggerCreation.triggerId;
      const notifyUri =
        triggerCreation.notifyUri ??
        `https://workspacestudio.googleapis.com/v1/triggers/${triggerId}:fire`;
      const inputs = triggerCreation.inputs || {};

      const instanceId =
        inputs.instanceId?.stringValues?.[0] ||
        getStringInput(event, 'instanceId') ||
        randomUUID();

      const requireApiKey =
        inputs.requireApiKey?.booleanValues?.[0] ??
        (inputs.requireApiKey?.stringValues?.[0] === 'true');

      createSubscription({
        triggerId,
        instanceId,
        userId,
        notifyUri,
        requireApiKey,
      });

      const apiKey = inputs.apiKey?.stringValues?.[0];
      if (apiKey) {
        addSecretForInstance({
          secretId: randomUUID(),
          instanceId,
          userId,
          label: formatSecretLabel(apiKey),
          secretHash: hashWebhookSecret(apiKey),
        });
      }

      res.json({});
      return;
    }

    if (triggerDeletion) {
      const triggerId = triggerDeletion.triggerId;
      // Idempotent deletion keyed by triggerId; cleans up secrets only when 0 subscriptions remain for instanceId
      deleteSubscriptionByTriggerId(triggerId);
      res.json({});
      return;
    }

    res.json({});
  } catch (err) {
    handleStudioError(err, res, 'Error managing trigger');
  }
});
