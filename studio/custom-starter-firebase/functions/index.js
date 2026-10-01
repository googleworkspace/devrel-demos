import { initializeApp } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'
import * as logger from 'firebase-functions/logger'
import { onDocumentCreated } from 'firebase-functions/v2/firestore'
import { onRequest } from 'firebase-functions/v2/https'
import {
  fireTriggersForRegistration,
  handleConfigSportsTrigger,
  handleManageSportsTrigger,
  handleOAuthCallback,
  handleOAuthStart,
  oauthClientId,
  oauthClientSecret,
} from './studioConfigManage.js'

const ADDON_SERVICE_ACCOUNT = 'service-287754070302@gcp-sa-gsuiteaddons.iam.gserviceaccount.com'

initializeApp()
const db = getFirestore()

/**
 * HTTP Cloud Function (2nd Gen) invoked by Google Workspace Studio (`onConfigFunction`)
 * when a user opens/configures the "New Sports Registration" starter in a flow.
 */
export const onConfigSportsTrigger = onRequest(
  {
    region: 'europe-west1',
    invoker: ADDON_SERVICE_ACCOUNT,
    secrets: [oauthClientId, oauthClientSecret],
  },
  (req, res) => handleConfigSportsTrigger(req, res, db)
)

/**
 * HTTP Cloud Function (2nd Gen) invoked by Google Workspace Studio (`onManageFunction`)
 * when a flow containing the starter is enabled/published (`triggerCreation`) or
 * disabled/deleted (`triggerDeletion`).
 */
export const onManageSportsTrigger = onRequest(
  {
    region: 'europe-west1',
    invoker: ADDON_SERVICE_ACCOUNT,
    secrets: [],
  },
  (req, res) => handleManageSportsTrigger(req, res, db)
)

/**
 * HTTP Cloud Function (2nd Gen) that initiates the OAuth 2.0 consent screen
 * (`access_type=offline`, scope `https://www.googleapis.com/auth/workspace.studio.trigger`).
 */
export const oauthStart = onRequest(
  {
    region: 'europe-west1',
    invoker: 'public', // must be public because the call is not made via the add-on service account
    secrets: [oauthClientId, oauthClientSecret],
  },
  (req, res) => handleOAuthStart(req, res)
)

/**
 * HTTP Cloud Function (2nd Gen) that handles the OAuth 2.0 redirect callback,
 * stores the offline refresh token in Firestore (`/studioAuth/{userId}`), and closes the popup.
 */
export const oauthCallback = onRequest(
  {
    region: 'europe-west1',
    invoker: 'public', // must be public because the call is not made via the add-on service account
    secrets: [oauthClientId, oauthClientSecret],
  },
  (req, res) => handleOAuthCallback(req, res, db)
)

/**
 * Cloud Function (2nd Gen) triggered whenever a new document is added
 * to the `registrations` collection in Cloud Firestore.
 * Refreshes each matching trigger owner's OAuth token and calls
 * `POST https://workspacestudio.googleapis.com/v1/triggers/{triggerId}:fire`.
 */
export const onRegistrationCreated = onDocumentCreated(
  {
    document: 'registrations/{registrationId}',
    database: '(default)',
    region: 'europe-west1',
    secrets: [oauthClientId, oauthClientSecret],
  },
  async (event) => {
    const snapshot = event.data
    if (!snapshot) {
      logger.warn('No data associated with registration creation event.')
      return
    }

    const { registrationId } = event.params
    const registration = snapshot.data()

    logger.info('New sports registration created in Firestore; firing active Workspace Studio triggers', {
      registrationId,
      participantName: registration.participantName,
      participantEmail: registration.participantEmail,
      offeringId: registration.offeringId,
      offeringTitle: registration.offeringTitle,
      offeringCategory: registration.offeringCategory,
    })

    const result = await fireTriggersForRegistration(db, {
      registrationId,
      registration,
    })

    logger.info('Completed Workspace Studio trigger execution for registration', {
      registrationId,
      ...result,
    })
  }
)
