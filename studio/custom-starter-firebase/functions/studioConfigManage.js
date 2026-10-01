import { FieldValue } from 'firebase-admin/firestore'
import * as logger from 'firebase-functions/logger'
import { defineSecret } from 'firebase-functions/params'
import { buildStudioTriggerPayload } from './starterPayload.js'

export const oauthClientId = defineSecret('OAUTH_CLIENT_ID')
export const oauthClientSecret = defineSecret('OAUTH_CLIENT_SECRET')

const STUDIO_TRIGGER_SCOPE = 'https://www.googleapis.com/auth/workspace.studio.trigger'
const DEFAULT_FUNCTION_BASE_URL = 'https://europe-west1-customstarter.cloudfunctions.net'

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

    const baseUrl = getFunctionBaseUrl(req)
    const startUrlObj = new URL(`${baseUrl}/oauthStart`)
    if (identity.userId) {
      startUrlObj.searchParams.set('userId', identity.userId)
    }
    if (identity.userEmail) {
      startUrlObj.searchParams.set('userEmail', identity.userEmail)
    }
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
 * Initiates the OAuth 2.0 offline consent screen for `workspace.studio.trigger`
 * using `OAUTH_CLIENT_ID` from Google Cloud Secret Manager, forwarding the
 * invoking user's `userId` in the OAuth `state` parameter.
 */
export async function handleOAuthStart(req, res) {
  try {
    const config = getOAuthClientConfig(req)

    if (!config.clientId) {
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

    const userId = req.query.userId ? String(req.query.userId).trim() : null
    const userEmail = req.query.userEmail ? String(req.query.userEmail).trim().toLowerCase() : null
    const statePayload = Buffer.from(
      JSON.stringify({ userId, userEmail })
    ).toString('base64url')

    const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth')
    authUrl.searchParams.set('client_id', config.clientId)
    authUrl.searchParams.set('redirect_uri', config.redirectUri)
    authUrl.searchParams.set('response_type', 'code')
    authUrl.searchParams.set('scope', `${STUDIO_TRIGGER_SCOPE} openid email profile`)
    authUrl.searchParams.set('access_type', 'offline')
    authUrl.searchParams.set('prompt', 'consent')
    authUrl.searchParams.set('state', statePayload)
    if (userEmail) {
      authUrl.searchParams.set('login_hint', userEmail)
    }

    res.redirect(authUrl.toString())
  } catch (error) {
    logger.error('Error in oauthStart', error)
    res.status(500).send(`OAuth initialization error: ${error.message}`)
  }
}

/**
 * Handler for `oauthCallback` (HTTP GET).
 * Exchanges the OAuth 2.0 authorization code for an access token and offline refresh token,
 * resolves the user's Google `userId` (`sub`), stores the credentials in `/studioAuth/{userId}`,
 * and closes the overlay window.
 */
export async function handleOAuthCallback(req, res, db) {
  try {
    const { code, state, error: oauthError } = req.query
    if (oauthError) {
      res.status(400).send(`OAuth error returned by Google: ${oauthError}`)
      return
    }
    if (!code) {
      res.status(400).send('Missing ?code= parameter on OAuth callback.')
      return
    }

    let stateUserId = null
    let stateUserEmail = null
    if (state) {
      try {
        const parsed = JSON.parse(Buffer.from(String(state), 'base64url').toString('utf8'))
        stateUserId = parsed.userId || null
        stateUserEmail = parsed.userEmail || null
      } catch {
        // Ignore malformed state
      }
    }

    const config = getOAuthClientConfig(req)
    if (!config.clientId || !config.clientSecret) {
      res.status(400).send('OAUTH_CLIENT_ID and OAUTH_CLIENT_SECRET are not configured in Secret Manager.')
      return
    }

    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        code: String(code),
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uri: config.redirectUri,
        grant_type: 'authorization_code',
      }),
    })

    const tokenData = await tokenResponse.json()
    if (!tokenResponse.ok) {
      logger.error('Failed to exchange authorization code for tokens', tokenData)
      res.status(400).send(`Token exchange failed: ${JSON.stringify(tokenData)}`)
      return
    }

    let resolvedUserId = null
    let connectedEmail = null

    // 1. Check id_token returned from Google token endpoint
    const idTokenClaims = decodeJwtPayload(tokenData.id_token)
    if (idTokenClaims) {
      resolvedUserId = idTokenClaims.sub || null
      connectedEmail = idTokenClaims.email ? String(idTokenClaims.email).toLowerCase() : null
    }

    // 2. Fetch userinfo endpoint if needed
    if ((!resolvedUserId || !connectedEmail) && tokenData.access_token) {
      try {
        const userResp = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
          headers: { Authorization: `Bearer ${tokenData.access_token}` },
        })
        if (userResp.ok) {
          const userInfo = await userResp.json()
          resolvedUserId = resolvedUserId || userInfo.id || null
          connectedEmail =
            connectedEmail || (userInfo.email ? String(userInfo.email).toLowerCase() : null)
        }
      } catch (err) {
        logger.warn('Could not fetch userinfo during OAuth callback', err)
      }
    }

    const targetUserId = resolvedUserId || stateUserId || connectedEmail || 'default'
    const targetUserEmail = connectedEmail || stateUserEmail || null

    const updatePayload = {
      userId: targetUserId,
      accessToken: tokenData.access_token,
      scope: tokenData.scope || STUDIO_TRIGGER_SCOPE,
      tokenType: tokenData.token_type || 'Bearer',
      expiresIn: tokenData.expires_in || 3600,
      connectedEmail: targetUserEmail,
      updatedAt: FieldValue.serverTimestamp(),
    }

    if (tokenData.refresh_token) {
      updatePayload.refreshToken = tokenData.refresh_token
    }

    await db.collection('studioAuth').doc(String(targetUserId)).set(updatePayload, { merge: true })

    // Backfill userId onto any existing trigger subscriptions that were created by this user
    // before per-user credential linking was added
    const existingTriggersSnap = await db.collection('studioTriggers').get()
    for (const trigDoc of existingTriggersSnap.docs) {
      const trigData = trigDoc.data()
      if (
        !trigData.userId ||
        (targetUserEmail && trigData.userEmail && trigData.userEmail === targetUserEmail)
      ) {
        await trigDoc.ref.set(
          {
            userId: String(targetUserId),
            userEmail: targetUserEmail,
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true }
        )
      }
    }

    logger.info('Successfully stored per-user offline OAuth 2.0 credentials in /studioAuth/{userId}', {
      userId: targetUserId,
      connectedEmail: targetUserEmail,
      hasRefreshToken: Boolean(tokenData.refresh_token),
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
    <p>PulseWell is now authorized to fire Google Workspace Studio triggers${targetUserEmail ? ` as <b>${targetUserEmail}</b>` : ''}.</p>
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
