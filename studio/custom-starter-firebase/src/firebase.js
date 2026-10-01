import { initializeApp } from 'firebase/app'
import { getAuth } from 'firebase/auth'
import { getFirestore } from 'firebase/firestore'

/**
 * Firebase configuration for GCP/Firebase project "customstarter" (pulsewell-web).
 */
export const firebaseConfig = {
  apiKey: 'TODO_DEFINE_API_KEY',
  authDomain: 'customstarter.firebaseapp.com',
  projectId: 'customstarter',
  storageBucket: 'customstarter.firebasestorage.app',
  messagingSenderId: '287754070302',
  appId: '1:287754070302:web:50407709f44d9b55adc10f',
}

export const app = initializeApp(firebaseConfig)
export const auth = getAuth(app)
export const db = getFirestore(app)
