/**
 * Initial catalog of health and sports offerings on the PulseWell platform.
 */
export const SPORTS_OFFERINGS = [
  {
    id: 'sunrise-vinyasa',
    title: 'Sunrise Vinyasa Flow & Mobility',
    category: 'Mind & Body',
    schedule: 'Tue & Thu · 07:30 – 08:30 AM',
    location: 'Studio A · Wellness Pavilion',
    instructor: 'Maya Lin',
    intensity: 'All Levels',
    totalSpots: 18,
    registeredCount: 14,
    summary:
      'Breath-synchronized flow and joint mobility work designed to counteract desk posture and build morning focus.',
  },
  {
    id: 'tempo-run-clinic',
    title: '5K Tempo Run & Stride Mechanics',
    category: 'Endurance',
    schedule: 'Wednesdays · 05:30 – 06:45 PM',
    location: 'Bayfront Track & Waterfront Trail',
    instructor: 'Marcus Vance',
    intensity: 'Intermediate',
    totalSpots: 24,
    registeredCount: 19,
    summary:
      'Guided cadence drills, pacing strategy, and a progressive 5K group tempo run along the waterfront path.',
  },
  {
    id: 'kettlebell-strength-lab',
    title: 'Kettlebell & Functional Strength Lab',
    category: 'Strength',
    schedule: 'Mon & Fri · 12:00 – 12:50 PM',
    location: 'Performance Turf · Floor 2',
    instructor: 'Elena Rostova',
    intensity: 'Intermediate',
    totalSpots: 16,
    registeredCount: 13,
    summary:
      'Foundational hinge, press, and carry progressions focused on posterior chain resilience and core stability.',
  },
  {
    id: 'indoor-cycling-intervals',
    title: 'Wattage & Cadence Spin Intervals',
    category: 'Cardio',
    schedule: 'Thursdays · 06:00 – 06:50 PM',
    location: 'Cycle Amphitheater · Room 104',
    instructor: 'Devon Brooks',
    intensity: 'High Energy',
    totalSpots: 20,
    registeredCount: 17,
    summary:
      'Power-zone intervals and hill climbs tracked with live watt metrics for aerobic conditioning.',
  },
  {
    id: 'freestyle-swim-clinic',
    title: 'Lap Swim & Freestyle Technique',
    category: 'Aquatics',
    schedule: 'Wed & Fri · 08:00 – 09:00 AM',
    location: 'Olympic Pool · Lanes 1–4',
    instructor: 'Kenji Sato',
    intensity: 'All Levels',
    totalSpots: 12,
    registeredCount: 9,
    summary:
      'Stroke efficiency coaching, bilateral breathing drills, and structured endurance sets in heated 50m lanes.',
  },
  {
    id: 'ergonomic-core-recovery',
    title: 'Thoracic Mobility & Active Recovery',
    category: 'Recovery',
    schedule: 'Daily · 03:00 – 03:30 PM',
    location: 'Recovery Lounge & Hybrid Stream',
    instructor: 'Dr. Sarah Chen, PT',
    intensity: 'Gentle',
    totalSpots: 30,
    registeredCount: 21,
    summary:
      'Mid-afternoon decompression session targeting neck, shoulder, and hip flexor tension with guided myofascial release.',
  },
]

export const OFFERING_CATEGORIES = [
  'All Offerings',
  'Mind & Body',
  'Endurance',
  'Strength',
  'Cardio',
  'Aquatics',
  'Recovery',
]

/**
 * Sample participants for one-click form filling during live demos.
 */
export const SAMPLE_PARTICIPANTS = [
  {
    participantName: 'Alex Rivera',
    participantEmail: 'alex.rivera@example.com',
    department: 'Cloud Developer Relations',
    experienceLevel: 'Intermediate',
    notes: 'Bringing own mat; interested in recurring Tuesday morning slot.',
  },
  {
    participantName: 'Samira Patel',
    participantEmail: 'samira.patel@example.com',
    department: 'Workspace Product Engineering',
    experienceLevel: 'Beginner',
    notes: 'First time joining the campus wellness program!',
  },
  {
    participantName: 'Jordan Lee',
    participantEmail: 'jordan.lee@example.com',
    department: 'Security & Trust',
    experienceLevel: 'Advanced',
    notes: 'Preparing for the autumn corporate half-marathon.',
  },
]

/**
 * Formats a registration event into the payload expected by the
 * Google Workspace Studio API `triggers.fire` endpoint:
 * POST https://workspacestudio.googleapis.com/v1/triggers/{triggerId}:fire
 */
export function buildWorkspaceStudioTriggerPayload(registration, triggerId = 'YOUR_TRIGGER_ID') {
  const cleanTriggerId = triggerId.trim() || 'YOUR_TRIGGER_ID'
  const instructorAndLocation = [registration.instructor, registration.offeringLocation]
    .filter(Boolean)
    .join(' · ')

  return {
    name: `triggers/${cleanTriggerId}`,
    outputs: {
      recipientEmail: {
        emailAddressValues: [registration.participantEmail],
      },
      participantName: {
        stringValues: [registration.participantName],
      },
      offeringTitle: {
        stringValues: [registration.offeringTitle],
      },
      offeringCategory: {
        stringValues: [registration.offeringCategory],
      },
      offeringSchedule: {
        stringValues: [registration.offeringSchedule],
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
    requestId: registration.requestId,
  }
}
