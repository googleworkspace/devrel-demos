import { useState } from 'react'
import { SAMPLE_PARTICIPANTS } from '../data/sportsOfferings'

export default function RegistrationModal({ offering, onClose, onSubmitRegistration }) {
  const [participantName, setParticipantName] = useState('')
  const [participantEmail, setParticipantEmail] = useState('')
  const [department, setDepartment] = useState('')
  const [experienceLevel, setExperienceLevel] = useState('Intermediate')
  const [notes, setNotes] = useState('')
  const [sampleIndex, setSampleIndex] = useState(0)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState('')

  if (!offering) return null

  const handleFillSample = () => {
    const sample = SAMPLE_PARTICIPANTS[sampleIndex % SAMPLE_PARTICIPANTS.length]
    setParticipantName(sample.participantName)
    setParticipantEmail(sample.participantEmail)
    setDepartment(sample.department)
    setExperienceLevel(sample.experienceLevel)
    setNotes(sample.notes)
    setSampleIndex((prev) => prev + 1)
    setSubmitError('')
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (!participantName.trim() || !participantEmail.trim() || isSubmitting) return

    setIsSubmitting(true)
    setSubmitError('')

    const requestId =
      typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : `req-${Date.now()}`

    try {
      await onSubmitRegistration({
        requestId,
        offeringId: offering.id,
        offeringTitle: offering.title,
        offeringCategory: offering.category,
        offeringSchedule: offering.schedule,
        offeringLocation: offering.location,
        instructor: offering.instructor,
        participantName: participantName.trim(),
        participantEmail: participantEmail.trim(),
        department: department.trim() || 'General Wellness',
        experienceLevel,
        notes: notes.trim(),
        createdAt: new Date().toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        }),
      })
    } catch (err) {
      setSubmitError(err.message || 'Failed to save registration to Firestore.')
      setIsSubmitting(false)
    }
  }

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="register-modal-title"
    >
      <div className="modal-panel">
        <div className="modal-header">
          <div>
            <span className="offering-category-tag">{offering.category}</span>
            <h2 id="register-modal-title" style={{ marginTop: '6px' }}>
              Register for {offering.title}
            </h2>
            <p className="sidebar-subtitle">
              {offering.schedule} · {offering.location}
            </p>
          </div>
          <button
            type="button"
            id="close-registration-modal-btn"
            className="modal-close-btn"
            onClick={onClose}
            disabled={isSubmitting}
            aria-label="Close registration modal"
          >
            ×
          </button>
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            background: 'var(--bg-elevated)',
            padding: '10px 14px',
            borderRadius: 'var(--radius-sm)',
            gap: '12px',
          }}
        >
          <span style={{ fontSize: '0.83rem', color: 'var(--text-secondary)' }}>
            Submitting saves this registration to <strong>Cloud Firestore</strong> (
            <code>registrations</code> collection).
          </span>
          <button
            type="button"
            id="fill-sample-participant-btn"
            className="btn btn-secondary"
            style={{ padding: '6px 12px', fontSize: '0.8rem', whiteSpace: 'nowrap' }}
            onClick={handleFillSample}
            disabled={isSubmitting}
          >
            Fill Demo Participant
          </button>
        </div>

        {submitError && (
          <div
            role="alert"
            style={{
              background: 'var(--status-warning-soft)',
              color: 'var(--status-warning)',
              padding: '10px 14px',
              borderRadius: 'var(--radius-sm)',
              fontSize: '0.84rem',
              fontWeight: 600,
            }}
          >
            Firestore Error: {submitError}
          </div>
        )}

        <form id="sports-registration-form" className="form-stack" onSubmit={handleSubmit}>
          <div className="form-row-2">
            <div className="form-field">
              <label className="form-label" htmlFor="participant-name-input">
                Participant Full Name *
              </label>
              <input
                id="participant-name-input"
                type="text"
                className="form-input"
                placeholder="e.g. Alex Rivera"
                value={participantName}
                onChange={(e) => setParticipantName(e.target.value)}
                disabled={isSubmitting}
                required
              />
            </div>

            <div className="form-field">
              <label className="form-label" htmlFor="participant-email-input">
                Recipient Email (Confirmation Target) *
              </label>
              <input
                id="participant-email-input"
                type="email"
                className="form-input"
                placeholder="alex.rivera@yourdomain.com"
                value={participantEmail}
                onChange={(e) => setParticipantEmail(e.target.value)}
                disabled={isSubmitting}
                required
              />
            </div>
          </div>

          <div className="form-row-2">
            <div className="form-field">
              <label className="form-label" htmlFor="participant-department-input">
                Team / Department
              </label>
              <input
                id="participant-department-input"
                type="text"
                className="form-input"
                placeholder="e.g. Developer Relations"
                value={department}
                onChange={(e) => setDepartment(e.target.value)}
                disabled={isSubmitting}
              />
            </div>

            <div className="form-field">
              <label className="form-label" htmlFor="participant-level-select">
                Experience Level
              </label>
              <select
                id="participant-level-select"
                className="form-select"
                value={experienceLevel}
                onChange={(e) => setExperienceLevel(e.target.value)}
                disabled={isSubmitting}
              >
                <option value="Beginner">Beginner</option>
                <option value="Intermediate">Intermediate</option>
                <option value="Advanced">Advanced</option>
              </select>
            </div>
          </div>

          <div className="form-field">
            <label className="form-label" htmlFor="participant-notes-textarea">
              Mobility or Equipment Notes (Optional)
            </label>
            <textarea
              id="participant-notes-textarea"
              className="form-textarea"
              rows={2}
              placeholder="Any goals, equipment preferences, or instructor notes..."
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              disabled={isSubmitting}
            />
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '6px' }}>
            <button
              type="button"
              id="cancel-registration-btn"
              className="btn btn-secondary"
              onClick={onClose}
              disabled={isSubmitting}
            >
              Cancel
            </button>
            <button
              type="submit"
              id="submit-registration-btn"
              className="btn btn-accent"
              disabled={isSubmitting}
            >
              {isSubmitting ? 'Saving to Firestore...' : 'Complete Registration'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
