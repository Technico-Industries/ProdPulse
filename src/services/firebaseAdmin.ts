import { initializeApp, getApps, getApp } from 'firebase/app';
import { getAuth, createUserWithEmailAndPassword, sendPasswordResetEmail, signOut } from 'firebase/auth';
import { doc, setDoc, serverTimestamp } from 'firebase/firestore';
import { auth, firebaseConfig, db } from './firebase';

const SECONDARY_APP_NAME = 'Secondary';

function getSecondaryAuth() {
  const secondaryApp = getApps().some((a) => a.name === SECONDARY_APP_NAME)
    ? getApp(SECONDARY_APP_NAME)
    : initializeApp(firebaseConfig, SECONDARY_APP_NAME);
  // No persistence needed here — this auth instance only lives long enough
  // to create the account, then immediately signs itself out.
  return getAuth(secondaryApp);
}

interface NewSupervisor {
  name: string;
  employeeCode: string;
  email: string;
  password: string;
  plant: string;
  assign: string; // Supervisor | Technician | Restocker | Quality Control
  createdBy: string; // admin uid
}

/**
 * Creates an incharge account via a secondary Firebase Auth instance so the
 * currently signed-in admin (on the primary auth instance) stays logged in.
 * The internal auth `role` stays 'supervisor' for all incharge types (this
 * is what gates app access to the supervisor dashboard); `assign` records
 * their actual floor job function separately.
 */
export async function createSupervisorAccount({
  name,
  employeeCode,
  email,
  password,
  plant,
  assign,
  createdBy,
}: NewSupervisor) {
  const secondaryAuth = getSecondaryAuth();
  const cred = await createUserWithEmailAndPassword(secondaryAuth, email.trim(), password);

  await setDoc(doc(db, 'users', cred.user.uid), {
    name: name.trim(),
    employeeCode: employeeCode.trim(),
    email: email.trim(),
    plant,
    assign,
    role: 'supervisor',
    active: true,
    createdBy,
    createdAt: serverTimestamp(),
  });

  // Clean up the secondary session; the primary admin session is untouched.
  await signOut(secondaryAuth);

  return cred.user.uid;
}

/**
 * Sends Firebase's built-in password reset email to a supervisor's login
 * email. This does not require signing in as them and does not disturb the
 * admin's current session — it just triggers Firebase's own reset flow.
 */
export async function sendSupervisorPasswordReset(email: string) {
  await sendPasswordResetEmail(auth, email.trim());
}