import { randomUUID } from 'node:crypto'

const UUID_V4_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/**
 * Builds the request body for the Google Workspace Studio `triggers.fire` API endpoint:
 * POST https://workspacestudio.googleapis.com/v1/triggers/{triggerId}:fire
 *
 * @param {Object} registration - The Firestore registration document data
 * @param {string} triggerId - The Workspace Studio trigger subscription ID
 * @param {Object} [options] - Optional overrides (e.g. forceNewRequestId)
 * @returns {Object} Formatted Workspace Studio FireTriggerRequest payload
 */
export function buildStudioTriggerPayload(
  registration,
  triggerId = 'PENDING_TRIGGER_ID',
  { forceNewRequestId = false } = {}
) {
  const candidateId = !forceNewRequestId && registration.requestId ? String(registration.requestId) : ''
  const requestId = UUID_V4_REGEX.test(candidateId) ? candidateId : randomUUID()

  const instructorAndLocation = [registration.instructor, registration.offeringLocation]
    .filter(Boolean)
    .join(' · ')

  return {
    name: `triggers/${triggerId}`,
    outputs: {
      recipientEmail: {
        emailAddressValues: [registration.participantEmail || ''],
      },
      participantName: {
        stringValues: [registration.participantName || ''],
      },
      offeringTitle: {
        stringValues: [registration.offeringTitle || ''],
      },
      offeringCategory: {
        stringValues: [registration.offeringCategory || ''],
      },
      offeringSchedule: {
        stringValues: [registration.offeringSchedule || ''],
      },
      instructorAndLocation: {
        stringValues: [instructorAndLocation],
      },
    },
    log: {
      textFormatElements: [
        {
          text: `New sports registration: ${registration.participantName} (${registration.participantEmail}) signed up for "${registration.offeringTitle}".`,
        },
      ],
    },
    requestId,
  }
}
