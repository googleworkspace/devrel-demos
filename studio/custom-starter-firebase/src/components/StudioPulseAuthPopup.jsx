import { signInWithEmailAndPassword, signOut } from 'firebase/auth'
import { useState } from 'react'
import { auth } from '../firebase'

const STUDIO_LINK_ENDPOINT =
  import.meta.env.VITE_STUDIO_LINK_ENDPOINT ||
  'https://europe-west1-customstarter.cloudfunctions.net/oauthStart'

export default function StudioPulseAuthPopup({ studioState, adminUser }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')
  const [linkedResult, setLinkedResult] = useState(null)

  const linkFirebaseUserToStudio = async (firebaseUser) => {
    const firebaseIdToken = await firebaseUser.getIdToken(true)
    const response = await fetch(STUDIO_LINK_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        state: studioState,
        firebaseIdToken,
      }),
    })

    const data = await response.json().catch(() => ({}))
    if (!response.ok || !data.ok) {
      throw new Error(data.error || `Failed to link PulseWell account (HTTP ${response.status})`)
    }

    setLinkedResult(data)
    setTimeout(() => {
      window.close()
    }, 3000)
  }

  const handleSignInAndLink = async (e) => {
    e.preventDefault()
    const cleanEmail = email.trim()
    if (!cleanEmail || !password) {
      setErrorMessage('Please enter both your admin email and password.')
      return
    }

    setIsSubmitting(true)
    setErrorMessage('')

    try {
      const credential = await signInWithEmailAndPassword(auth, cleanEmail, password)
      await linkFirebaseUserToStudio(credential.user)
    } catch (err) {
      console.error('Studio PulseWell Admin link error:', err)
      if (
        err.code === 'auth/invalid-credential' ||
        err.code === 'auth/user-not-found' ||
        err.code === 'auth/wrong-password'
      ) {
        setErrorMessage('Invalid email or password. Admin accounts are managed in Firebase Auth.')
      } else {
        setErrorMessage(err.message || 'Failed to authenticate and link PulseWell Admin account.')
      }
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleLinkExistingSession = async () => {
    if (!adminUser) return
    setIsSubmitting(true)
    setErrorMessage('')
    try {
      await linkFirebaseUserToStudio(adminUser)
    } catch (err) {
      console.error('Studio PulseWell Admin link error:', err)
      setErrorMessage(err.message || 'Failed to link PulseWell Admin account.')
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleSwitchAccount = async () => {
    setErrorMessage('')
    await signOut(auth)
  }

  if (linkedResult) {
    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '24px',
          background: '#f0fdf4',
        }}
      >
        <div
          style={{
            background: '#ffffff',
            border: '1px solid #bbf7d0',
            borderRadius: '14px',
            padding: '28px',
            maxWidth: '440px',
            width: '100%',
            textAlign: 'center',
            boxShadow: '0 8px 24px rgba(6, 78, 59, 0.08)',
          }}
        >
          <div
            style={{
              width: '44px',
              height: '44px',
              borderRadius: '50%',
              background: '#dcfce7',
              color: '#047857',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontWeight: 700,
              fontSize: '1.2rem',
              marginBottom: '12px',
            }}
          >
            ✓
          </div>
          <h2 style={{ margin: '0 0 8px', color: '#047857', fontSize: '1.25rem' }}>
            PulseWell Admin Connected
          </h2>
          <p style={{ margin: '0 0 12px', fontSize: '0.9rem', color: '#334155', lineHeight: 1.5 }}>
            Verified PulseWell Admin <b>{linkedResult.pulseEmail}</b> is now linked to your Google
            Workspace Studio account
            {linkedResult.gwsEmail ? (
              <>
                {' '}
                (<b>{linkedResult.gwsEmail}</b>)
              </>
            ) : null}
            .
          </p>
          <p style={{ margin: '0 0 18px', fontSize: '0.82rem', color: '#64748b' }}>
            This window will close automatically and reload your starter card.
          </p>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => window.close()}
            style={{ width: '100%' }}
          >
            Close Window
          </button>
        </div>
      </div>
    )
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px',
        background: 'var(--bg-canvas)',
      }}
    >
      <div className="modal-card" style={{ maxWidth: '440px', width: '100%' }}>
        <div className="modal-header">
          <div>
            <span className="offering-category-tag">Google Workspace Studio</span>
            <h2 className="modal-title" style={{ marginTop: '6px' }}>
              PulseWell Admin Authentication
            </h2>
          </div>
        </div>

        {adminUser ? (
          <div className="modal-form">
            <p className="offering-summary" style={{ margin: 0 }}>
              You are currently signed in to PulseWell as an Admin:
            </p>
            <div
              style={{
                padding: '12px 14px',
                borderRadius: 'var(--radius-sm)',
                background: 'var(--bg-subtle)',
                border: '1px solid var(--border-subtle)',
                fontWeight: 600,
                fontSize: '0.9rem',
              }}
            >
              {adminUser.email}
            </div>

            {errorMessage && (
              <div
                role="alert"
                style={{
                  background: 'var(--status-warning-soft)',
                  color: 'var(--status-warning)',
                  padding: '10px 12px',
                  borderRadius: 'var(--radius-sm)',
                  fontSize: '0.82rem',
                }}
              >
                {errorMessage}
              </div>
            )}

            <div className="modal-actions" style={{ flexDirection: 'column', gap: '8px' }}>
              <button
                type="button"
                id="studio-confirm-admin-btn"
                className="btn btn-primary btn-full"
                disabled={isSubmitting}
                onClick={handleLinkExistingSession}
              >
                {isSubmitting ? 'Linking Account...' : `Link ${adminUser.email} to Studio`}
              </button>
              <button
                type="button"
                id="studio-switch-admin-btn"
                className="btn btn-secondary btn-full"
                disabled={isSubmitting}
                onClick={handleSwitchAccount}
              >
                Use a Different Admin Account
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSignInAndLink} className="modal-form">
            <p className="offering-summary" style={{ margin: 0 }}>
              Sign in with your PulseWell Admin credentials (Firebase Auth) to authorize your Google
              Workspace Studio flow to subscribe to Firestore registrations.
            </p>

            <div className="form-group">
              <label htmlFor="studio-admin-email" className="form-label">
                Admin Email
              </label>
              <input
                id="studio-admin-email"
                type="email"
                className="form-input"
                placeholder="admin@yourdomain.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="username"
                required
              />
            </div>

            <div className="form-group">
              <label htmlFor="studio-admin-password" className="form-label">
                Password
              </label>
              <input
                id="studio-admin-password"
                type="password"
                className="form-input"
                placeholder="Enter your password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
              />
            </div>

            {errorMessage && (
              <div
                role="alert"
                style={{
                  background: 'var(--status-warning-soft)',
                  color: 'var(--status-warning)',
                  padding: '10px 12px',
                  borderRadius: 'var(--radius-sm)',
                  fontSize: '0.82rem',
                }}
              >
                {errorMessage}
              </div>
            )}

            <div className="modal-actions">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => window.close()}
                disabled={isSubmitting}
              >
                Cancel
              </button>
              <button
                type="submit"
                id="studio-admin-submit-btn"
                className="btn btn-primary"
                disabled={isSubmitting}
              >
                {isSubmitting ? 'Verifying & Linking...' : 'Sign In & Link to Studio'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}
