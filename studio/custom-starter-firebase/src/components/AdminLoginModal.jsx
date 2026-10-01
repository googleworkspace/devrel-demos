import { signInWithEmailAndPassword } from 'firebase/auth'
import { useState } from 'react'
import { auth } from '../firebase'

export default function AdminLoginModal({ onClose, onSuccess }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [isSigningIn, setIsSigningIn] = useState(false)
  const [authError, setAuthError] = useState('')

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (!email.trim() || !password || isSigningIn) return

    setIsSigningIn(true)
    setAuthError('')

    try {
      const credential = await signInWithEmailAndPassword(auth, email.trim(), password)
      if (onSuccess) {
        onSuccess(credential.user)
      }
      onClose()
    } catch (err) {
      let friendlyMessage = 'Invalid email or password. Please verify your admin credentials.'
      if (err.code === 'auth/too-many-requests') {
        friendlyMessage = 'Too many failed attempts. Please wait a moment and try again.'
      } else if (err.code === 'auth/operation-not-allowed') {
        friendlyMessage =
          'Email/Password sign-in is not enabled yet in Firebase Console (Authentication > Sign-in method).'
      } else if (err.message) {
        friendlyMessage = err.message
      }
      setAuthError(friendlyMessage)
      setIsSigningIn(false)
    }
  }

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="admin-login-modal-title"
    >
      <div className="modal-panel" style={{ maxWidth: '460px' }}>
        <div className="modal-header">
          <div>
            <span className="offering-category-tag">PulseWell Administration</span>
            <h2 id="admin-login-modal-title" style={{ marginTop: '6px' }}>
              Admin Sign In
            </h2>
            <p className="sidebar-subtitle">
              Sign in with your Firebase Auth admin account to inspect live registrations and
              manage Google Workspace Studio starter subscriptions.
            </p>
          </div>
          <button
            type="button"
            id="close-admin-login-modal-btn"
            className="modal-close-btn"
            onClick={onClose}
            disabled={isSigningIn}
            aria-label="Close admin sign-in modal"
          >
            ×
          </button>
        </div>

        {authError && (
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
            {authError}
          </div>
        )}

        <form id="admin-login-form" className="form-stack" onSubmit={handleSubmit}>
          <div className="form-field">
            <label className="form-label" htmlFor="admin-email-input">
              Admin Email *
            </label>
            <input
              id="admin-email-input"
              type="email"
              className="form-input"
              placeholder="admin@yourdomain.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={isSigningIn}
              autoComplete="email"
              required
            />
          </div>

          <div className="form-field">
            <label className="form-label" htmlFor="admin-password-input">
              Password *
            </label>
            <input
              id="admin-password-input"
              type="password"
              className="form-input"
              placeholder="Enter your password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={isSigningIn}
              autoComplete="current-password"
              required
            />
          </div>

          <div
            style={{
              display: 'flex',
              justifyContent: 'flex-end',
              gap: '10px',
              marginTop: '8px',
            }}
          >
            <button
              type="button"
              id="cancel-admin-login-btn"
              className="btn btn-secondary"
              onClick={onClose}
              disabled={isSigningIn}
            >
              Cancel
            </button>
            <button
              type="submit"
              id="submit-admin-login-btn"
              className="btn btn-primary"
              disabled={isSigningIn}
            >
              {isSigningIn ? 'Signing in...' : 'Sign In'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
