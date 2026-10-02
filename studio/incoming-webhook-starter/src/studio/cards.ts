import type { Card, Section, Widget } from '../types.js';
import type { SecretRecord } from '../db/schema.js';

/**
 * Visual Mockup of the Google Workspace Studio Configuration Card:
 *
 * ┌──────────────────────────────────────────────────────────────────┐
 * │                     Incoming Webhook Starter                     │
 * │               Receive HTTP POST webhooks (max 1 KB)              │
 * ├──────────────────────────────────────────────────────────────────┤
 * │ Authorization                                                    │
 * │   Status: Account Authorization Required                         │
 * │   [ Authorize Account ] (opens OAuth popup dialog)               │
 * ├──────────────────────────────────────────────────────────────────┤
 * │ Webhook Endpoint                                                 │
 * │   Webhook POST URL:                                              │
 * │   https://{host}/webhook/{triggerId || instanceId}               │
 * │                                                                  │
 * │   Example request:                                               │
 * │   curl -X POST "{url}" -H "X-Webhook-Secret: ..." -d '{...}'     │
 * ├──────────────────────────────────────────────────────────────────┤
 * │ Webhook Security (Optional)                                      │
 * │   Require API Key                                [ Switch: ON ]  │
 * │   Key: Production Webhook (whsec_1234...5678)       [ 🗑️ Delete ] │
 * │   [ + Add Secret ]                                               │
 * └──────────────────────────────────────────────────────────────────┘
 */

export interface BuildConfigCardParams {
  baseUrl: string;
  instanceId: string;
  triggerId?: string;
  isAuthorized: boolean;
  requireApiKey: boolean;
  secrets: SecretRecord[];
  newlyCreatedSecret?: string | null;
}

/**
 * Builds the Authorization Status section.
 * Guides the user to authorize offline OAuth access if credentials aren't stored yet.
 */
export function buildAuthSection(baseUrl: string, isAuthorized: boolean): Section {
  const authWidgets: Widget[] = [];

  if (!isAuthorized) {
    authWidgets.push(
      {
        decoratedText: {
          topLabel: 'Account Authorization Required',
          text: 'You must authorize offline access so this bridge can trigger Studio workflows when webhooks arrive.',
          wrapText: true,
        },
      },
      {
        buttonList: {
          buttons: [
            {
              text: 'Authorize Account',
              type: 'FILLED',
              onClick: {
                openLink: {
                  url: `${baseUrl}/auth/start`,
                  openAs: 'OVERLAY',
                  onClose: 'RELOAD',
                },
              },
            },
          ],
        },
      }
    );
  } else {
    authWidgets.push({
      decoratedText: {
        topLabel: 'Status',
        text: '✅ Account authorized — long-lived credentials saved.',
        wrapText: true,
      },
    });
  }

  return {
    id: 'auth_status_section',
    header: 'Authorization',
    widgets: authWidgets,
  };
}

/**
 * Builds the Webhook Endpoint section.
 * Shows the copy-ready webhook URL (using active triggerId if subscribed, or instanceId)
 * and an example curl invocation snippet.
 */
export function buildEndpointSection(params: {
  baseUrl: string;
  instanceId: string;
  triggerId?: string;
  requireApiKey: boolean;
}): Section {
  const { baseUrl, instanceId, triggerId, requireApiKey } = params;
  const webhookId = triggerId || instanceId;
  const webhookUrl = `${baseUrl}/webhook/${webhookId}`;

  const curlSnippet = requireApiKey
    ? `curl -X POST "${webhookUrl}" -H "X-Webhook-Secret: &lt;YOUR_SECRET&gt;" -d '{"event":"order.created"}'`
    : `curl -X POST "${webhookUrl}" -d '{"event":"order.created"}'`;

  const widgets: Widget[] = [
    // Hidden widget storing instanceId to correlate the card across Studio events
    {
      visibility: 'HIDDEN',
      textInput: {
        name: 'instanceId',
        value: instanceId,
      },
    },
    {
      textParagraph: {
        text: `<b>Webhook POST URL:</b>\n${webhookUrl}`,
      },
    },
    {
      textParagraph: {
        text: `<b>Example request:</b>\n${curlSnippet}`,
      },
    },
  ];

  return {
    id: 'webhook_endpoint_section',
    header: 'Webhook Endpoint',
    widgets,
  };
}

/**
 * Builds the API Key Security section with switch toggle, secret keys list,
 * one-time revelation banner, and secret creation input.
 */
export function buildApiKeySection(params: {
  baseUrl: string;
  requireApiKey: boolean;
  secrets: SecretRecord[];
  newlyCreatedSecret?: string | null;
}): Section {
  const { baseUrl, requireApiKey, secrets, newlyCreatedSecret } = params;

  const widgets: Widget[] = [
    {
      selectionInput: {
        name: 'requireApiKey',
        label: 'Security',
        type: 'SWITCH',
        items: [
          {
            text: 'Require API Key (X-Webhook-Secret / Authorization: ApiKey <secret>)',
            value: 'true',
            selected: requireApiKey,
          },
        ],
        onChangeAction: {
          function: `${baseUrl}/studio/on-toggle-api-key`,
          persistValues: true,
        },
      },
    },
  ];

  if (requireApiKey) {
    // 1. One-time secret reveal banner (shown only immediately upon secret generation)
    if (newlyCreatedSecret) {
      widgets.push(
        {
          decoratedText: {
            topLabel: 'New Secret Generated',
            text: '⚠️ Copy this secret now — we only store a cryptographic hash and it cannot be retrieved again.',
            wrapText: true,
          },
        },
        {
          textInput: {
            name: 'oneTimeSecretDisplay',
            label: 'Secret Key (Copy Now)',
            value: newlyCreatedSecret,
            hintText: 'Pass via header: X-Webhook-Secret: ' + newlyCreatedSecret,
          },
        }
      );
    }

    // 2. Active hashed secrets list with revocation trash button
    if (secrets.length === 0) {
      widgets.push({
        textParagraph: {
          text: 'No active secrets configured. Generate a secret below to authenticate requests.',
        },
      });
    } else {
      for (const secret of secrets) {
        const createdDate = new Date(secret.createdAt).toISOString().slice(0, 10);
        widgets.push({
          decoratedText: {
            text: secret.label,
            bottomLabel: `Created ${createdDate}`,
            wrapText: true,
            button: {
              altText: `Delete secret ${secret.label}`,
              icon: {
                materialIcon: {
                  name: 'delete',
                },
              },
              onClick: {
                action: {
                  function: `${baseUrl}/studio/on-delete-secret`,
                  parameters: [{ key: 'secretId', value: secret.secretId }],
                  persistValues: true,
                },
              },
            },
          },
        });
      }
    }

    // 3. New secret generation controls
    widgets.push(
      {
        textInput: {
          name: 'newSecretLabel',
          label: 'Secret Label (Optional)',
          placeholderText: 'e.g. Production Webhook',
          value: '',
        },
      },
      {
        buttonList: {
          buttons: [
            {
              text: 'Regenerate Secret',
              type: 'OUTLINED',
              icon: {
                materialIcon: {
                  name: 'add',
                },
              },
              onClick: {
                action: {
                  function: `${baseUrl}/studio/on-add-secret`,
                  persistValues: true,
                },
              },
            },
          ],
        },
      }
    );
  }

  return {
    id: 'api_key_section',
    header: 'Webhook Security (Optional)',
    widgets,
  };
}

/**
 * Assembles the full configuration Card presented to the user in Workspace Studio.
 */
export function buildConfigCard(params: BuildConfigCardParams): Card {
  const {
    baseUrl,
    instanceId,
    triggerId,
    isAuthorized,
    requireApiKey,
    secrets,
    newlyCreatedSecret,
  } = params;

  return {
    header: {
      title: 'Incoming Webhook Starter',
      subtitle: 'Receive HTTP POST webhooks (max 1 KB)',
    },
    sections: [
      buildAuthSection(baseUrl, isAuthorized),
      buildEndpointSection({
        baseUrl,
        instanceId,
        triggerId,
        requireApiKey,
      }),
      buildApiKeySection({
        baseUrl,
        requireApiKey,
        secrets,
        newlyCreatedSecret,
      }),
    ],
  };
}
