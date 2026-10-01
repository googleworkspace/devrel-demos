import { onAuthStateChanged, signOut } from 'firebase/auth'
import {
  addDoc,
  collection,
  doc,
  increment,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
} from 'firebase/firestore'
import { useEffect, useMemo, useState } from 'react'
import heroImage from './assets/wellness-hero.jpg'
import AdminLoginModal from './components/AdminLoginModal'
import RegistrationModal from './components/RegistrationModal'
import StudioPulseAuthPopup from './components/StudioPulseAuthPopup'
import {
  OFFERING_CATEGORIES,
  SPORTS_OFFERINGS,
  buildWorkspaceStudioTriggerPayload,
} from './data/sportsOfferings'
import { auth, db } from './firebase'

export default function App() {
  const studioState = useMemo(() => {
    const params = new URLSearchParams(window.location.search)
    return params.get('studioState') || ''
  }, [])

  const [offerings, setOfferings] = useState(SPORTS_OFFERINGS)
  const [selectedCategory, setSelectedCategory] = useState('All Offerings')
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedOfferingForReg, setSelectedOfferingForReg] = useState(null)
  const [adminUser, setAdminUser] = useState(null)
  const [isAdminLoginOpen, setIsAdminLoginOpen] = useState(false)
  const [registrations, setRegistrations] = useState([])
  const [isLoadingRegistrations, setIsLoadingRegistrations] = useState(false)
  const [firestoreError, setFirestoreError] = useState('')

  // Track Firebase Auth admin state
  useEffect(() => {
    const unsubscribeAuth = onAuthStateChanged(auth, (user) => {
      setAdminUser(user)
      setIsLoadingRegistrations(Boolean(user))
      if (!user) {
        setRegistrations([])
        setFirestoreError('')
      }
    })
    return () => unsubscribeAuth()
  }, [])

  // Subscribe to offerings collection in Firestore so spot counts stay in sync
  useEffect(() => {
    const unsubscribeOfferings = onSnapshot(
      collection(db, 'offerings'),
      (snapshot) => {
        if (!snapshot.empty) {
          const firestoreOfferingsMap = new Map()
          snapshot.docs.forEach((docSnap) => {
            firestoreOfferingsMap.set(docSnap.id, {
              ...docSnap.data(),
              id: docSnap.id,
            })
          })

          // Merge Firestore offerings in catalog order
          setOfferings(
            SPORTS_OFFERINGS.map((defaultItem) =>
              firestoreOfferingsMap.get(defaultItem.id) || defaultItem
            )
          )
        }
      },
      (err) => {
        console.error('Error listening to offerings collection:', err)
      }
    )

    return () => unsubscribeOfferings()
  }, [])

  // Subscribe to registrations collection in Firestore only when an admin user is signed in
  useEffect(() => {
    if (!adminUser) {
      return
    }

    const registrationsQuery = query(
      collection(db, 'registrations'),
      orderBy('timestamp', 'desc')
    )

    const unsubscribeRegistrations = onSnapshot(
      registrationsQuery,
      (snapshot) => {
        const docs = snapshot.docs.map((docSnap) => ({
          ...docSnap.data(),
          id: docSnap.id,
        }))
        setRegistrations(docs)
        setIsLoadingRegistrations(false)
        setFirestoreError('')
      },
      (err) => {
        console.error('Error listening to registrations collection:', err)
        setFirestoreError(err.message || 'Could not read registrations from Firestore.')
        setIsLoadingRegistrations(false)
      }
    )

    return () => unsubscribeRegistrations()
  }, [adminUser])

  const filteredOfferings = useMemo(() => {
    return offerings.filter((item) => {
      const matchesCategory =
        selectedCategory === 'All Offerings' || item.category === selectedCategory
      const queryText = searchQuery.trim().toLowerCase()
      const matchesQuery =
        !queryText ||
        item.title.toLowerCase().includes(queryText) ||
        item.instructor.toLowerCase().includes(queryText) ||
        item.location.toLowerCase().includes(queryText) ||
        item.category.toLowerCase().includes(queryText)
      return matchesCategory && matchesQuery
    })
  }, [offerings, selectedCategory, searchQuery])

  const handleCompleteRegistration = async (newReg) => {
    // 1. Write the new registration document to the `registrations` collection in Firestore
    await addDoc(collection(db, 'registrations'), {
      ...newReg,
      timestamp: serverTimestamp(),
    })

    // 2. Increment the registeredCount on the offering document in the `offerings` collection
    const targetOffering = offerings.find((item) => item.id === newReg.offeringId)
    if (targetOffering) {
      const offeringRef = doc(db, 'offerings', targetOffering.id)
      await setDoc(
        offeringRef,
        {
          ...targetOffering,
          registeredCount: increment(1),
        },
        { merge: true }
      )
    }

    setSelectedOfferingForReg(null)
  }

  const handleAdminSignOut = async () => {
    try {
      await signOut(auth)
    } catch (err) {
      console.error('Error signing out admin user:', err)
    }
  }

  if (studioState) {
    return <StudioPulseAuthPopup studioState={studioState} adminUser={adminUser} />
  }

  return (
    <div className="app-shell">
      {/* Main Navigation Header */}
      <header className="site-header">
        <div className="container site-header-inner">
          <div className="brand-identity">
            <div className="brand-mark" aria-hidden="true">
              P
            </div>
            <div>
              <span className="brand-title">PulseWell</span>
              <span className="brand-subtitle">
                Corporate Health &amp; Sports Offerings
              </span>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <div className="nav-tabs" aria-label="Catalog summary">
              <span className="nav-tab active">
                Sports Offerings
                <span className="badge-count">{offerings.length}</span>
              </span>
            </div>

            {adminUser ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <span
                  className="offering-category-tag"
                  style={{ textTransform: 'none', fontSize: '0.8rem', padding: '6px 10px' }}
                  title="Signed in as PulseWell Admin"
                >
                  Admin: {adminUser.email}
                </span>
                <button
                  type="button"
                  id="admin-signout-btn"
                  className="btn btn-secondary"
                  style={{ padding: '7px 14px', fontSize: '0.84rem' }}
                  onClick={handleAdminSignOut}
                >
                  Sign Out
                </button>
              </div>
            ) : (
              <button
                type="button"
                id="admin-signin-btn"
                className="btn btn-secondary"
                style={{ padding: '8px 14px', fontSize: '0.85rem' }}
                onClick={() => setIsAdminLoginOpen(true)}
              >
                Admin Sign In
              </button>
            )}
          </div>
        </div>
      </header>

      <main className="container">
        {/* Hero Banner */}
        <section className="hero-section" aria-labelledby="main-hero-heading">
          <div className="hero-card">
            <div className="hero-content">
              <div>
                <div className="hero-eyebrow">Campus Wellness &amp; Athletics</div>
                <h1 id="main-hero-heading" className="hero-headline">
                  Move with your team. Reserve your next session.
                </h1>
                <p className="hero-description">
                  Sign up for weekly campus fitness, endurance, and recovery offerings. When you
                  register, your sign-up is stored in Cloud Firestore and triggers our Workspace
                  Studio flow to send a confirmation email to your inbox.
                </p>
              </div>

              <div className="hero-workflow-strip" aria-label="Registration workflow">
                <span className="workflow-step-tag">1. Choose Offering</span>
                <span className="workflow-arrow" aria-hidden="true">
                  →
                </span>
                <span className="workflow-step-tag">2. Save to Firestore</span>
                <span className="workflow-arrow" aria-hidden="true">
                  →
                </span>
                <span className="workflow-step-tag">3. Trigger Confirmation Email</span>
              </div>
            </div>

            <div className="hero-media">
              <img
                src={heroImage}
                alt="Employees practicing yoga and running in a sunlit corporate wellness studio"
                className="hero-image"
              />
            </div>
          </div>
        </section>

        {/* Category Filter & Search Bar */}
        <section className="catalog-toolbar" aria-label="Filter sports offerings">
          <div className="category-pills" role="group" aria-label="Offering categories">
            {OFFERING_CATEGORIES.map((category) => (
              <button
                key={category}
                type="button"
                id={`filter-category-${category.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`}
                className={`category-pill ${selectedCategory === category ? 'active' : ''}`}
                onClick={() => setSelectedCategory(category)}
              >
                {category}
              </button>
            ))}
          </div>

          <div className="search-box">
            <input
              id="search-offerings-input"
              type="search"
              className="search-input"
              placeholder="Search sports, coach, or studio..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              aria-label="Search sports offerings"
            />
          </div>
        </section>

        {/* Offerings Grid + Conditional Admin Firestore Registrations Sidebar */}
        <div className={`workspace-layout ${adminUser ? '' : 'workspace-layout--single'}`}>
          <section aria-label="Available sports offerings" className="offerings-grid">
            {filteredOfferings.map((offering) => {
              const spotsRemaining = offering.totalSpots - offering.registeredCount
              const isFull = spotsRemaining <= 0

              return (
                <article key={offering.id} className="offering-card">
                  <div className="offering-card-top">
                    <div className="offering-meta-row">
                      <span className="offering-category-tag">{offering.category}</span>
                      <span
                        className={`offering-spots ${spotsRemaining <= 4 ? 'low' : ''}`}
                      >
                        {isFull
                          ? 'Waitlist Only'
                          : `${spotsRemaining} of ${offering.totalSpots} spots left`}
                      </span>
                    </div>

                    <h2 className="offering-title">{offering.title}</h2>
                    <p className="offering-summary">{offering.summary}</p>

                    <ul className="offering-details-list">
                      <li className="offering-detail-item">
                        <span className="offering-detail-label">Schedule</span>
                        <span className="offering-detail-value">{offering.schedule}</span>
                      </li>
                      <li className="offering-detail-item">
                        <span className="offering-detail-label">Location</span>
                        <span className="offering-detail-value">{offering.location}</span>
                      </li>
                      <li className="offering-detail-item">
                        <span className="offering-detail-label">Coach</span>
                        <span className="offering-detail-value">{offering.instructor}</span>
                      </li>
                      <li className="offering-detail-item">
                        <span className="offering-detail-label">Intensity</span>
                        <span className="offering-detail-value">{offering.intensity}</span>
                      </li>
                    </ul>
                  </div>

                  <div className="offering-card-footer">
                    <button
                      type="button"
                      id={`register-btn-${offering.id}`}
                      className="btn btn-primary btn-full"
                      disabled={isFull}
                      onClick={() => setSelectedOfferingForReg(offering)}
                    >
                      {isFull ? 'Session Full' : 'Sign Up Participant'}
                    </button>
                  </div>
                </article>
              )
            })}
          </section>

          {/* Right Sidebar: Live Firestore Registrations (Visible only to authenticated Admins) */}
          {adminUser && (
            <aside className="studio-sidebar" aria-labelledby="starter-feed-heading">
              <div className="sidebar-header">
                <div>
                  <h2 id="starter-feed-heading" className="sidebar-title">
                    Firestore Registrations
                  </h2>
                  <p className="sidebar-subtitle">
                    Live documents in <code>/registrations</code>
                  </p>
                </div>
                <span className="badge-count">{registrations.length}</span>
              </div>

              {firestoreError && (
                <div
                  role="alert"
                  style={{
                    background: 'var(--status-warning-soft)',
                    color: 'var(--status-warning)',
                    padding: '10px 12px',
                    borderRadius: 'var(--radius-sm)',
                    fontSize: '0.8rem',
                  }}
                >
                  {firestoreError}
                </div>
              )}

              <div className="registration-feed">
                {isLoadingRegistrations ? (
                  <p className="sidebar-subtitle">Loading registrations from Firestore...</p>
                ) : registrations.length === 0 ? (
                  <p className="sidebar-subtitle">
                    No registrations in Firestore yet. Click &ldquo;Sign Up Participant&rdquo; on
                    any offering to create the first document!
                  </p>
                ) : (
                  registrations.map((reg, index) => {
                    const payload = buildWorkspaceStudioTriggerPayload(reg)
                    return (
                      <div key={reg.id} className="registration-item">
                        <div className="registration-item-header">
                          <span className="registration-participant">{reg.participantName}</span>
                          <span className="registration-status-badge">Saved in DB</span>
                        </div>
                        <div className="registration-offering-name">{reg.offeringTitle}</div>
                        <div className="registration-meta">
                          {reg.participantEmail} · {reg.createdAt}
                        </div>
                        <div className="registration-meta">
                          Doc ID: <code>{reg.id}</code>
                        </div>

                        <details className="payload-preview-details" open={index === 0}>
                          <summary id={`inspect-payload-${reg.id}`}>
                            Starter Event Payload
                          </summary>
                          <pre className="code-block">{JSON.stringify(payload, null, 2)}</pre>
                        </details>
                      </div>
                    )
                  })
                )}
              </div>
            </aside>
          )}
        </div>
      </main>

      {/* Registration Modal (Normal Users / Course Participants) */}
      {selectedOfferingForReg && (
        <RegistrationModal
          key={selectedOfferingForReg.id}
          offering={selectedOfferingForReg}
          onClose={() => setSelectedOfferingForReg(null)}
          onSubmitRegistration={handleCompleteRegistration}
        />
      )}

      {/* Admin Sign-In Modal */}
      {isAdminLoginOpen && (
        <AdminLoginModal
          onClose={() => setIsAdminLoginOpen(false)}
          onSuccess={(user) => setAdminUser(user)}
        />
      )}
    </div>
  )
}
