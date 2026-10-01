import { createHmac, timingSafeEqual } from 'node:crypto'
import { FieldValue } from 'firebase-admin/firestore'
import * as logger from 'firebase-functions/logger'
import { defineSecret } from 'firebase-functions/params'
import { OAuth2Client } from 'google-auth-library'
import { buildStudioTriggerPayload } from './starterPayload.js'

export const oauthClientId = defineSecret('OAUTH_CLIENT_ID')
export const oauthClientSecret = defineSecret('OAUTH_CLIENT_SECRET')

const STUDIO_TRIGGER_SCOPE = 'https://www.googleapis.com/auth/workspace.studio.trigger'
const DEFAULT_FUNCTION_BASE_URL = 'https://europe-west1-customstarter.cloudfunctions.net'
const OAUTH_STATE_TTL_MS = 15 * 60 * 1000 // 15 minutes

/**
 * Helper to resolve the base URL for HTTP Cloud Functions in this project.
 */
function getFunctionBaseUrl(req) {
  if (process.env.FUNCTION_BASE_URL) {
    return process.env.FUNCTION_BASE_URL.replace(/\/$/, '')
  }
  const host = req.get('x-forwarded-host') || req.get('host')
  const protocol = req.get('x-forwarded-proto') || req.protocol || 'https'
  if (host && host.includes('cloudfunctions.net')) {
    return `${protocol}://${host}`
  }
  return DEFAULT_FUNCTION_BASE_URL
}

/**
 * Reads OAuth 2.0 client configuration from Google Cloud Secret Manager
 * via `firebase-functions/params` (`defineSecret`).
 */
export function getOAuthClientConfig(req) {
  const baseUrl = req ? getFunctionBaseUrl(req) : DEFAULT_FUNCTION_BASE_URL
  const defaultRedirectUri = `${baseUrl}/oauthCallback`

  const clientId = oauthClientId.value() || process.env.OAUTH_CLIENT_ID || null
  const clientSecret = oauthClientSecret.value() || process.env.OAUTH_CLIENT_SECRET || null

  return {
    clientId: clientId ? clientId.trim() : null,
    clientSecret: clientSecret ? clientSecret.trim() : null,
    redirectUri: process.env.OAUTH_REDIRECT_URI || defaultRedirectUri,
  }
}

/**
 * Creates a Google `OAuth2Client` instance configured with the app's Web Client credentials.
 */
function createOAuth2Client(config) {
  return new OAuth2Client(config.clientId, config.clientSecret, config.redirectUri)
}

/**
 * Creates an HMAC-SHA256 signed OAuth `state` token containing the invoking
 * Google Workspace user's `userId` (`sub`), `userEmail`, and expiration timestamp.
 */
function createSignedOAuthState({ userId, userEmail }, clientSecret) {
  const payloadB64 = Buffer.from(
    JSON.stringify({
      userId: userId ? String(userId).trim() : null,
      userEmail: userEmail ? String(userEmail).trim().toLowerCase() : null,
      exp: Date.now() + OAUTH_STATE_TTL_MS,
    })
  ).toString('base64url')

  if (!clientSecret) {
    return payloadB64
  }

  const signatureB64 = createHmac('sha256', clientSecret)
    .update(payloadB64)
    .digest('base64url')

  return `${payloadB64}.${signatureB64}`
}

/**
 * Verifies an HMAC-SHA256 signed OAuth `state` token and returns the decoded payload
 * if the signature is valid, the token has not expired, and `userId` is present.
 */
function verifySignedOAuthState(stateToken, clientSecret) {
  if (!stateToken || typeof stateToken !== 'string' || !clientSecret) {
    return null
  }

  const parts = stateToken.split('.')
  if (parts.length !== 2) {
    return null
  }

  const [payloadB64, signatureB64] = parts
  const expectedSig = createHmac('sha256', clientSecret).update(payloadB64).digest()
  let actualSig
  try {
    actualSig = Buffer.from(signatureB64, 'base64url')
  } catch {
    return null
  }

  if (expectedSig.length !== actualSig.length || !timingSafeEqual(expectedSig, actualSig)) {
    return null
  }

  try {
    const parsed = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'))
    if (!parsed || !parsed.userId) {
      return null
    }
    if (typeof parsed.exp === 'number' && Date.now() > parsed.exp) {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

/**
 * Decodes the JSON payload of a JWT without external dependencies.
 */
function decodeJwtPayload(jwtString) {
  if (!jwtString || typeof jwtString !== 'string') {
    return null
  }
  const parts = jwtString.split('.')
  if (parts.length < 2) {
    return null
  }
  try {
    const json = Buffer.from(parts[1], 'base64url').toString('utf8')
    return JSON.parse(json)
  } catch {
    return null
  }
}

/**
 * Extracts the invoking Google Workspace user's immutable `userId` (`sub` / Gaia ID)
 * and `userEmail` from `authorizationEventObject` (`userIdToken` or `userOAuthToken`).
 */
async function resolveEventUserIdentity(body) {
  const authObj = body?.authorizationEventObject || {}
  const userIdToken = authObj.userIdToken
  const userOAuthToken = authObj.userOAuthToken
  const authorizedScopes = authObj.authorizedScopes || []

  let userId = null
  let userEmail = null

  const idTokenClaims = decodeJwtPayload(userIdToken)
  if (idTokenClaims) {
    userId = idTokenClaims.sub || null
    userEmail = idTokenClaims.email || null
  }

  // If userId or userEmail is not in userIdToken, query Google userinfo with userOAuthToken
  // (supported by https://www.googleapis.com/auth/userinfo.email in deployment.json)
  if ((!userId || !userEmail) && userOAuthToken) {
    try {
      const resp = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { Authorization: `Bearer ${userOAuthToken}` },
      })
      if (resp.ok) {
        const info = await resp.json()
        userId = userId || info.id || null
        userEmail = userEmail || info.email || null
      }
    } catch (err) {
      logger.warn('Failed to fetch userinfo from userOAuthToken', err)
    }
  }

  return {
    userId: userId ? String(userId).trim() : null,
    userEmail: userEmail ? String(userEmail).trim().toLowerCase() : null,
    userOAuthToken: userOAuthToken || null,
    authorizedScopes,
  }
}

/**
 * Captures the invoking user's identity and short-lived `userOAuthToken`
 * inside `/studioAuth/{userId}` in Firestore.
 */
async function captureEventOAuthTokenIfPresent(db, body) {
  const identity = await resolveEventUserIdentity(body)
  if (!identity.userId) {
    return identity
  }

  const updateData = {
    userId: identity.userId,
    lastEventTokenCapturedAt: FieldValue.serverTimestamp(),
  }
  if (identity.userEmail) {
    updateData.connectedEmail = identity.userEmail
  }
  if (identity.userOAuthToken) {
    updateData.lastEventUserOAuthToken = identity.userOAuthToken
    updateData.lastEventAuthorizedScopes = identity.authorizedScopes
  }

  await db
    .collection('studioAuth')
    .doc(identity.userId)
    .set(updateData, { merge: true })

  return identity
}

/**
 * Builds the Google Workspace Add-on configuration card (`RenderActions` JSON)
 * returned by `onConfigSportsTrigger`.
 */
function buildStarterConfigurationCard({ isOfflineAuthorized, connectedEmail, oauthStartUrl }) {
  const connectionStatusText = isOfflineAuthorized
    ? `<b>Status:</b> Connected (${connectedEmail || 'Offline Refresh Token stored'})`
    : '<b>Status:</b> Offline OAuth 2.0 refresh token not yet authorized for your account. Click below to grant offline access for asynchronous <code>triggers.fire</code> calls.'

  const authButtonText = isOfflineAuthorized
    ? 'Re-authorize Offline Access'
    : 'Authorize PulseWell Offline Access'

  return {
    action: {
      navigations: [
        {
          pushCard: {
            header: {
              title: 'PulseWell Sports Registration Starter',
              subtitle: 'Fires when an employee signs up for a sports offering',
            },
            sections: [
              {
                header: '1. Account & Offline Trigger Authorization',
                widgets: [
                  {
                    textParagraph: {
                      text: connectionStatusText,
                    },
                  },
                  {
                    buttonList: {
                      buttons: [
                        {
                          text: authButtonText,
                          onClick: {
                            openLink: {
                              url: oauthStartUrl,
                              onClose: 'RELOAD',
                              openAs: 'OVERLAY',
                            },
                          },
                        },
                      ],
                    },
                  },
                ],
              },
              {
                header: '2. Registration Filter',
                widgets: [
                  {
                    selectionInput: {
                      name: 'categoryFilter',
                      label: 'Sports Category to Watch',
                      type: 'DROPDOWN',
                      items: [
                        { text: 'All Sports Categories', value: 'ALL', selected: true },
                        { text: 'Mind & Body', value: 'Mind & Body', selected: false },
                        {
                          text: 'Cardio & Endurance',
                          value: 'Cardio & Endurance',
                          selected: false,
                        },
                        {
                          text: 'Strength & Mobility',
                          value: 'Strength & Mobility',
                          selected: false,
                        },
                        { text: 'Team Sports', value: 'Team Sports', selected: false },
                      ],
                    },
                  },
                  {
                    textParagraph: {
                      text: '<b>Emitted Output Variables:</b><br>• <code>recipientEmail</code> (Email address of registrant)<br>• <code>participantName</code> (Full name)<br>• <code>offeringTitle</code> (Selected course title)<br>• <code>offeringCategory</code> (Category)<br>• <code>offeringSchedule</code> (Day & time)<br>• <code>instructorAndLocation</code> (Instructor & location)',
                    },
                  },
                ],
              },
            ],
          },
        },
      ],
    },
  }
}

/**
 * Handler for `onConfigSportsTrigger` (HTTP POST from Google Workspace Studio).
 * Displays the configuration card and checks whether offline OAuth credentials
 * are stored in Firestore for the invoking user (`/studioAuth/{userId}`).
 */
export async function handleConfigSportsTrigger(req, res, db) {
  try {
    const body = req.body || {}
    const identity = await captureEventOAuthTokenIfPresent(db, body)

    logger.info('onConfigSportsTrigger invoked by Workspace Studio', {
      method: req.method,
      hostApp: body?.commonEventObject?.hostApp || body?.hostApp || 'WORKFLOW',
      userId: identity.userId,
      userEmail: identity.userEmail,
    })

    let authData = {}
    if (identity.userId) {
      const userAuthDoc = await db.collection('studioAuth').doc(identity.userId).get()
      if (userAuthDoc.exists) {
        authData = userAuthDoc.data()
      }
    }

    // Fallback to legacy `/studioAuth/default` if the user authorized prior to per-user keying
    if (!authData?.refreshToken) {
      const legacyDoc = await db.collection('studioAuth').doc('default').get()
      if (legacyDoc.exists) {
        const legacyData = legacyDoc.data()
        if (
          !identity.userEmail ||
          !legacyData.connectedEmail ||
          legacyData.connectedEmail.toLowerCase() === identity.userEmail
        ) {
          authData = legacyData
        }
      }
    }

    const isOfflineAuthorized = Boolean(authData?.refreshToken)

    const config = getOAuthClientConfig(req)
    const baseUrl = getFunctionBaseUrl(req)
    const startUrlObj = new URL(`${baseUrl}/oauthStart`)
    const signedState = createSignedOAuthState(
      {
        userId: identity.userId,
        userEmail: identity.userEmail,
      },
      config.clientSecret
    )
    startUrlObj.searchParams.set('state', signedState)
    const oauthStartUrl = startUrlObj.toString()

    // If explicitly requested via query param (?requireAuthPrompt=true) and not authorized yet,
    // return a standalone custom_authorization_prompt card as shown in connect-third-party-service.
    if (req.query.requireAuthPrompt === 'true' && !isOfflineAuthorized) {
      res.status(200).json({
        custom_authorization_prompt: {
          action: {
            navigations: [
              {
                pushCard: {
                  sections: [
                    {
                      widgets: [
                        {
                          textParagraph: {
                            text: 'PulseWell needs offline permission to notify Google Workspace Studio when a new sports registration occurs.',
                          },
                        },
                        {
                          buttonList: {
                            buttons: [
                              {
                                text: 'Sign in & Authorize',
                                onClick: {
                                  openLink: {
                                    url: oauthStartUrl,
                                    onClose: 'RELOAD',
                                    openAs: 'OVERLAY',
                                  },
                                },
                              },
                            ],
                          },
                        },
                      ],
                    },
                  ],
                },
              },
            ],
          },
        },
      })
      return
    }

    const cardResponse = buildStarterConfigurationCard({
      isOfflineAuthorized,
      connectedEmail: authData?.connectedEmail || identity.userEmail || null,
      oauthStartUrl,
    })

    res.status(200).json(cardResponse)
  } catch (error) {
    logger.error('Error in onConfigSportsTrigger', error)
    res.status(500).json({
      error: 'Failed to build starter configuration card',
      message: error.message,
    })
  }
}

/**
 * Handler for `onManageSportsTrigger` (HTTP POST from Google Workspace Studio).
 * Manages the subscription lifecycle (`triggerCreation` and `triggerDeletion`).
 */
export async function handleManageSportsTrigger(req, res, db) {
  try {
    const body = req.body || {}
    const workflow = body?.workflow || {}
    const triggerCreation = workflow.triggerCreation
    const triggerDeletion = workflow.triggerDeletion

    const identity = await captureEventOAuthTokenIfPresent(db, body)

    logger.info('onManageSportsTrigger invoked by Workspace Studio', {
      hasTriggerCreation: Boolean(triggerCreation),
      hasTriggerDeletion: Boolean(triggerDeletion),
      userId: identity.userId,
      userEmail: identity.userEmail,
      rawWorkflowKeys: Object.keys(workflow),
    })

    if (triggerCreation) {
      const triggerId = triggerCreation.triggerId
      if (!triggerId) {
        res.status(400).json({ error: 'Missing triggerCreation.triggerId' })
        return
      }

      const notifyUri =
        triggerCreation.notifyUri ||
        `https://workspacestudio.googleapis.com/v1/triggers/${triggerId}:fire`
      const inputs = triggerCreation.inputs || {}
      const categoryFilter = inputs?.categoryFilter?.stringValues?.[0] || 'ALL'

      await db
        .collection('studioTriggers')
        .doc(triggerId)
        .set(
          {
            triggerId,
            userId: identity.userId || null,
            userEmail: identity.userEmail || null,
            notifyUri,
            inputs,
            categoryFilter,
            createdAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true }
        )

      logger.info('Stored active Workspace Studio trigger subscription in Firestore', {
        triggerId,
        userId: identity.userId,
        userEmail: identity.userEmail,
        notifyUri,
        categoryFilter,
      })

      res.status(200).json({})
      return
    }

    if (triggerDeletion) {
      const triggerId = triggerDeletion.triggerId
      if (!triggerId) {
        res.status(200).json({})
        return
      }

      // Delete the trigger subscription document from Firestore (idempotent)
      await db.collection('studioTriggers').doc(triggerId).delete()

      logger.info('Deleted Workspace Studio trigger subscription document from Firestore', {
        triggerId,
        userId: identity.userId,
      })

      res.status(200).json({})
      return
    }

    logger.warn('onManageSportsTrigger called without triggerCreation or triggerDeletion', {
      body,
    })
    res.status(200).json({})
  } catch (error) {
    logger.error('Error in onManageSportsTrigger', error)
    res.status(500).json({
      error: 'Failed to process trigger lifecycle event',
      message: error.message,
    })
  }
}

/**
 * Handler for `oauthStart` (HTTP GET).
 * Verifies the HMAC-signed `state` token minted by `onConfigSportsTrigger` and initiates
 * the OAuth 2.0 offline consent screen for `workspace.studio.trigger`.
 */
export async function handleOAuthStart(req, res) {
  try {
    const config = getOAuthClientConfig(req)

    if (!config.clientId || !config.clientSecret) {
      res.status(200).send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>PulseWell OAuth 2.0 Secret Manager Setup</title>
  <style>
    body { font-family: Google Sans, Roboto, sans-serif; background: #f8fafc; color: #0f172a; padding: 24px; max-width: 540px; margin: 0 auto; }
    .card { background: #fff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 24px; box-shadow: 0 4px 12px rgba(15,23,42,0.05); }
    h2 { margin-top: 0; font-size: 18px; }
    p, li { font-size: 13px; line-height: 1.5; color: #475569; }
    code { background: #f1f5f9; padding: 2px 6px; border-radius: 4px; font-size: 12px; word-break: break-all; }
    pre { background: #0f172a; color: #f8fafc; padding: 12px; border-radius: 8px; font-size: 12px; overflow-x: auto; }
  </style>
</head>
<body>
  <div class="card">
    <h2>OAuth 2.0 Secrets Not Yet Configured</h2>
    <p>Store your OAuth 2.0 Web Client credentials in <b>Google Cloud Secret Manager</b> via the Firebase CLI:</p>
    <pre>firebase functions:secrets:set OAUTH_CLIENT_ID
firebase functions:secrets:set OAUTH_CLIENT_SECRET</pre>
    <p>Authorized Redirect URI to configure on your OAuth Client in Google Cloud Console:</p>
    <p><code>${config.redirectUri}</code></p>
  </div>
</body>
</html>`)
      return
    }

    const rawState = req.query.state ? String(req.query.state) : ''
    const verifiedState = verifySignedOAuthState(rawState, config.clientSecret)
    if (!verifiedState) {
      logger.warn('Rejected oauthStart request with missing, invalid, or expired signed state')
      res
        .status(403)
        .send(
          'Error: Invalid or expired authorization state. Please initiate authorization from the starter configuration card inside Google Workspace Studio.'
        )
      return
    }

    const oauth2Client = createOAuth2Client(config)
    const authorizeUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: [STUDIO_TRIGGER_SCOPE, 'openid', 'email', 'profile'].join(' '),
      prompt: 'consent',
      state: rawState,
      ...(verifiedState.userEmail ? { login_hint: verifiedState.userEmail } : {}),
    })

    res.redirect(authorizeUrl)
  } catch (error) {
    logger.error('Error in oauthStart', error)
    res.status(500).send(`OAuth initialization error: ${error.message}`)
  }
}

/**
 * Handler for `oauthCallback` (HTTP GET).
 * Verifies the HMAC-signed `state` token, exchanges the OAuth 2.0 authorization code for
 * credentials, cryptographically verifies `id_token` via `OAuth2Client.verifyIdToken`,
 * validates that the consenting user matches the Workspace Studio user in `state`,
 * stores the credentials in `/studioAuth/{userId}`, and closes the overlay window.
 */
export async function handleOAuthCallback(req, res, db) {
  try {
    const { code, state, error: oauthError } = req.query
    if (oauthError) {
      logger.warn('OAuth error returned by Google', { oauthError })
      res.status(400).send(`Error: ${oauthError}`)
      return
    }
    if (!code) {
      res.status(400).send('Missing ?code= parameter on OAuth callback.')
      return
    }

    const config = getOAuthClientConfig(req)
    if (!config.clientId || !config.clientSecret) {
      res
        .status(400)
        .send('OAUTH_CLIENT_ID and OAUTH_CLIENT_SECRET are not configured in Secret Manager.')
      return
    }

    const rawState = state ? String(state) : ''
    const verifiedState = verifySignedOAuthState(rawState, config.clientSecret)
    if (!verifiedState) {
      logger.warn('Rejected oauthCallback request with invalid or expired signed state')
      res
        .status(403)
        .send(
          'Error: Invalid or expired request state. Please start the configuration again from Google Workspace Studio.'
        )
      return
    }

    // Exchange authorization code for access, refresh, and ID tokens
    const oauth2Client = createOAuth2Client(config)
    const { tokens } = await oauth2Client.getToken(String(code))

    if (!tokens.id_token) {
      logger.error('OAuth token response did not include an id_token')
      res.status(400).send('Error: Missing id_token in OAuth response.')
      return
    }

    // Cryptographically verify the Google ID token signature, expiration, and audience
    const ticket = await oauth2Client.verifyIdToken({
      idToken: tokens.id_token,
      audience: config.clientId,
    })
    const tokenPayload = ticket.getPayload()
    const userId = tokenPayload?.sub ? String(tokenPayload.sub).trim() : null
    const connectedEmail = tokenPayload?.email
      ? String(tokenPayload.email).trim().toLowerCase()
      : verifiedState.userEmail || null

    // Validate that the user who granted consent is the same user who initiated the request in Studio
    if (!userId || userId !== String(verifiedState.userId)) {
      logger.warn('OAuth token user does not match Workspace Studio request user', {
        tokenUserId: userId,
        tokenEmail: connectedEmail,
        stateUserId: verifiedState.userId,
        stateEmail: verifiedState.userEmail,
      })
      res.status(403).send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Account Mismatch — PulseWell Authorization</title>
  <style>
    body { font-family: Google Sans, Roboto, sans-serif; background: #fef2f2; color: #7f1d1d; display: flex; align-items: center; justify-content: center; min-height: 90vh; margin: 0; }
    .box { background: #fff; border: 1px solid #fecaca; border-radius: 12px; padding: 28px; max-width: 460px; text-align: center; box-shadow: 0 4px 12px rgba(0,0,0,0.05); }
    h2 { margin-top: 0; color: #b91c1c; }
    p { font-size: 14px; color: #334155; line-height: 1.5; }
    button { margin-top: 12px; background: #dc2626; color: white; border: none; border-radius: 6px; padding: 10px 18px; font-weight: 600; cursor: pointer; }
  </style>
</head>
<body>
  <div class="box">
    <h2>Account Mismatch</h2>
    <p>The user who granted consent${connectedEmail ? ` (<b>${connectedEmail}</b>)` : ''} does not correspond to the user who initiated the request in Google Workspace Studio${verifiedState.userEmail ? ` (<b>${verifiedState.userEmail}</b>)` : ''}.</p>
    <p>Please close this window, start the configuration again, and select the same account you are using in Google Workspace Studio.</p>
    <button onclick="window.close()">Close Window</button>
  </div>
</body>
</html>`)
      return
    }

    const expiresIn = tokens.expiry_date
      ? Math.max(1, Math.round((tokens.expiry_date - Date.now()) / 1000))
      : 3600

    const updatePayload = {
      userId,
      accessToken: tokens.access_token,
      scope: tokens.scope || STUDIO_TRIGGER_SCOPE,
      tokenType: tokens.token_type || 'Bearer',
      expiresIn,
      connectedEmail,
      updatedAt: FieldValue.serverTimestamp(),
    }

    if (tokens.refresh_token) {
      updatePayload.refreshToken = tokens.refresh_token
    }

    await db.collection('studioAuth').doc(userId).set(updatePayload, { merge: true })

    // Backfill userId onto any existing trigger subscriptions created by this user
    const existingTriggersSnap = await db.collection('studioTriggers').get()
    for (const trigDoc of existingTriggersSnap.docs) {
      const trigData = trigDoc.data()
      if (
        !trigData.userId ||
        (connectedEmail && trigData.userEmail && trigData.userEmail === connectedEmail)
      ) {
        await trigDoc.ref.set(
          {
            userId,
            userEmail: connectedEmail,
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true }
        )
      }
    }

    logger.info('Successfully verified and stored per-user offline OAuth 2.0 credentials in /studioAuth/{userId}', {
      userId,
      connectedEmail,
      hasRefreshToken: Boolean(tokens.refresh_token),
    })

    res.status(200).send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>PulseWell Authorization Complete</title>
  <style>
    body { font-family: Google Sans, Roboto, sans-serif; background: #f0fdf4; color: #064e3b; display: flex; align-items: center; justify-content: center; min-height: 90vh; margin: 0; }
    .box { background: #fff; border: 1px solid #bbf7d0; border-radius: 12px; padding: 28px; max-width: 420px; text-align: center; box-shadow: 0 4px 12px rgba(0,0,0,0.05); }
    h2 { margin-top: 0; color: #047857; }
    p { font-size: 14px; color: #334155; }
    button { margin-top: 12px; background: #059669; color: white; border: none; border-radius: 6px; padding: 10px 18px; font-weight: 600; cursor: pointer; }
  </style>
</head>
<body>
  <div class="box">
    <h2>Authorization Successful</h2>
    <p>PulseWell is now authorized to fire Google Workspace Studio triggers${connectedEmail ? ` as <b>${connectedEmail}</b>` : ''}.</p>
    <p>This window will close automatically and reload your starter card.</p>
    <button onclick="window.close()">Close Window</button>
  </div>
  <script>
    setTimeout(() => { window.close(); }, 5000);
  </script>
</body>
</html>`)
  } catch (error) {
    logger.error('Error in oauthCallback', error)
    res.status(500).send(`OAuth callback failed: ${error.message}`)
  }
}

/**
 * Retrieves a valid OAuth 2.0 access token for the user who owns a specific trigger.
 * Looks up `/studioAuth/{userId}` (falling back to email match or `/studioAuth/default`
 * for pre-migration triggers) and exchanges the user's `refreshToken` for a fresh
 * access token using `OAUTH_CLIENT_ID` and `OAUTH_CLIENT_SECRET` from Secret Manager.
 */
export async function getValidStudioAccessToken(db, userId = null, userEmail = null) {
  let authDocRef = null
  let authSnap = null

  if (userId) {
    authDocRef = db.collection('studioAuth').doc(String(userId))
    authSnap = await authDocRef.get()
  }

  // Fallback by userEmail if userId doc was not found
  if ((!authSnap || !authSnap.exists) && userEmail) {
    const byEmailSnap = await db
      .collection('studioAuth')
      .where('connectedEmail', '==', String(userEmail).toLowerCase())
      .limit(1)
      .get()
    if (!byEmailSnap.empty) {
      authSnap = byEmailSnap.docs[0]
      authDocRef = authSnap.ref
    }
  }

  // Fallback to legacy `/studioAuth/default` if trigger was created before per-user migration
  if (!authSnap || !authSnap.exists) {
    authDocRef = db.collection('studioAuth').doc('default')
    authSnap = await authDocRef.get()
  }

  if (!authSnap || !authSnap.exists) {
    return null
  }

  const authData = authSnap.data()
  const config = getOAuthClientConfig()

  if (authData.refreshToken && config.clientId && config.clientSecret) {
    try {
      const response = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          client_id: config.clientId,
          client_secret: config.clientSecret,
          refresh_token: authData.refreshToken,
          grant_type: 'refresh_token',
        }),
      })

      const tokenData = await response.json()
      if (response.ok && tokenData.access_token) {
        await authDocRef.set(
          {
            accessToken: tokenData.access_token,
            expiresIn: tokenData.expires_in || 3600,
            refreshedAt: FieldValue.serverTimestamp(),
          },
          { merge: true }
        )
        return tokenData.access_token
      }

      logger.error('Failed to refresh offline OAuth token for user', {
        userId: userId || authDocRef.id,
        tokenData,
      })
    } catch (error) {
      logger.error('Error refreshing offline OAuth token for user', {
        userId: userId || authDocRef.id,
        error: error.message,
      })
    }
  }

  return authData.accessToken || authData.lastEventUserOAuthToken || null
}

/**
 * Queries active Workspace Studio trigger subscriptions in `/studioTriggers`,
 * filters by `categoryFilter`, exchanges each trigger owner's stored offline
 * refresh token (`/studioAuth/{userId}`) for a fresh access token, and calls
 * `POST https://workspacestudio.googleapis.com/v1/triggers/{triggerId}:fire`.
 */
export async function fireTriggersForRegistration(db, { registrationId, registration }) {
  const regDocRef = registrationId ? db.collection('registrations').doc(registrationId) : null

  // 1. Fetch Workspace Studio trigger subscriptions in `/studioTriggers`
  const triggersSnapshot = await db.collection('studioTriggers').get()
  const activeDocs = triggersSnapshot.docs.filter((docSnap) => docSnap.data()?.active !== false)

  const defaultPayload = buildStudioTriggerPayload(registration)

  if (activeDocs.length === 0) {
    logger.info(
      'No active Workspace Studio trigger subscriptions found in /studioTriggers yet. Recording prepared payload on registration document.',
      { registrationId }
    )

    if (regDocRef) {
      await regDocRef.set(
        {
          starterStatus: 'queued_awaiting_subscription',
          starterPayload: defaultPayload,
          starterProcessedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      )
    }
    return { starterStatus: 'queued_awaiting_subscription', firedTriggerIds: [] }
  }

  // 2. Filter subscriptions by optional categoryFilter configured on the starter card
  const matchingDocs = activeDocs.filter((docSnap) => {
    const data = docSnap.data()
    const filter = (data.categoryFilter || 'ALL').trim()
    if (!filter || filter.toUpperCase() === 'ALL') {
      return true
    }
    return filter.toLowerCase() === (registration.offeringCategory || '').trim().toLowerCase()
  })

  if (matchingDocs.length === 0) {
    logger.info('No active subscriptions matched the registration offeringCategory', {
      registrationId,
      offeringCategory: registration.offeringCategory,
    })

    if (regDocRef) {
      await regDocRef.set(
        {
          starterStatus: 'skipped_category_filter',
          starterPayload: defaultPayload,
          starterProcessedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      )
    }
    return { starterStatus: 'skipped_category_filter', firedTriggerIds: [] }
  }

  // 3. Fire each matching Workspace Studio trigger subscription using its owner's OAuth credentials
  const firedTriggerIds = []
  const fireResults = []
  const accessTokenCache = new Map()
  let firstPayload = defaultPayload

  for (let i = 0; i < matchingDocs.length; i++) {
    const triggerDoc = matchingDocs[i]
    const triggerData = triggerDoc.data()
    const triggerId = triggerData.triggerId || triggerDoc.id
    const triggerUserId = triggerData.userId || null
    const triggerUserEmail = triggerData.userEmail || null
    const notifyUri =
      triggerData.notifyUri ||
      `https://workspacestudio.googleapis.com/v1/triggers/${triggerId}:fire`

    const payload = buildStudioTriggerPayload(registration, triggerId, {
      forceNewRequestId: i > 0,
    })
    if (i === 0) {
      firstPayload = payload
    }

    const cacheKey = triggerUserId || triggerUserEmail || 'default'
    let accessToken = accessTokenCache.get(cacheKey)
    if (accessToken === undefined) {
      accessToken = await getValidStudioAccessToken(db, triggerUserId, triggerUserEmail)
      accessTokenCache.set(cacheKey, accessToken)
    }

    if (!accessToken) {
      logger.error('Cannot fire Workspace Studio trigger: missing OAuth token for trigger owner', {
        registrationId,
        triggerId,
        userId: triggerUserId,
        userEmail: triggerUserEmail,
      })
      fireResults.push({
        triggerId,
        userId: triggerUserId,
        status: 401,
        ok: false,
        error: 'Missing OAuth refresh token for trigger owner',
      })
      continue
    }

    try {
      const response = await fetch(notifyUri, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      })

      const responseText = await response.text()
      let responseBody = {}
      try {
        responseBody = responseText ? JSON.parse(responseText) : {}
      } catch {
        responseBody = { raw: responseText }
      }

      if (response.ok) {
        logger.info('Successfully fired Workspace Studio trigger!', {
          registrationId,
          triggerId,
          userId: triggerUserId,
          notifyUri,
          status: response.status,
        })
        firedTriggerIds.push(triggerId)
        fireResults.push({
          triggerId,
          userId: triggerUserId,
          status: response.status,
          ok: true,
        })

        await triggerDoc.ref.set(
          {
            lastFiredAt: FieldValue.serverTimestamp(),
            lastFireStatus: response.status,
            fireCount: FieldValue.increment(1),
          },
          { merge: true }
        )
      } else if (response.status === 404) {
        // Per Build a Starter spec: 404 means the flow/trigger was disabled or deleted.
        // Delete the subscription document so future registrations do not call it.
        logger.warn(
          'Workspace Studio returned 404 Not Found for trigger. Deleting subscription from /studioTriggers.',
          {
            registrationId,
            triggerId,
            userId: triggerUserId,
            responseBody,
          }
        )
        fireResults.push({
          triggerId,
          userId: triggerUserId,
          status: 404,
          ok: false,
          error: 'Trigger not found (deleted subscription document)',
        })

        await triggerDoc.ref.delete()
      } else {
        logger.error('Workspace Studio triggers.fire returned an error status', {
          registrationId,
          triggerId,
          userId: triggerUserId,
          status: response.status,
          responseBody,
        })
        fireResults.push({
          triggerId,
          userId: triggerUserId,
          status: response.status,
          ok: false,
          error: responseBody?.error?.message || responseText || `HTTP ${response.status}`,
        })

        await triggerDoc.ref.set(
          {
            lastFireStatus: response.status,
            lastFireError:
              responseBody?.error?.message || responseText || `HTTP ${response.status}`,
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true }
        )
      }
    } catch (err) {
      logger.error('Network/fetch error calling Workspace Studio triggers.fire', {
        registrationId,
        triggerId,
        userId: triggerUserId,
        error: err.message,
      })
      fireResults.push({
        triggerId,
        userId: triggerUserId,
        status: 0,
        ok: false,
        error: err.message,
      })
    }
  }

  const starterStatus = firedTriggerIds.length > 0 ? 'fired' : 'fire_failed'
  if (regDocRef) {
    await regDocRef.set(
      {
        starterStatus,
        starterTriggerIds: firedTriggerIds,
        starterResults: fireResults,
        starterPayload: firstPayload,
        starterProcessedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    )
  }

  return {
    starterStatus,
    firedTriggerIds,
    fireResults,
  }
}
