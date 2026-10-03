import { create } from 'zustand';
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
  User as FirebaseUser,
} from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { auth, db } from '../services/firebase';

export type UserRole = 'admin' | 'supervisor';

export interface AuthUser {
  uid: string;
  email: string | null;
  name: string | null;
  role: UserRole;
  assign: string | null; // Supervisor | Technician | Restocker | Quality Control (null for admins)
}

interface AuthState {
  user: AuthUser | null;
  initializing: boolean;
  error: string | null;
  login: (email: string, password: string) => Promise<boolean>;
  logout: () => Promise<void>;
  clearError: () => void;
}

interface UserProfile {
  role: UserRole;
  active: boolean;
  name: string | null;
  assign: string | null;
}

async function resolveProfile(uid: string): Promise<UserProfile | null> {
  try {
    const snap = await getDoc(doc(db, 'users', uid));
    if (!snap.exists()) {
      // No profile doc -> default to supervisor, active (backward compatible).
      return { role: 'supervisor', active: true, name: null, assign: null };
    }
    const data = snap.data();
    return {
      role: data.role === 'admin' ? 'admin' : 'supervisor',
      // Missing `active` field = treat as active (existing accounts predate this field).
      active: data.active !== false,
      name: data.name ?? null,
      assign: data.assign ?? null,
    };
  } catch (err) {
    console.error('[resolveProfile] Firestore read failed for uid', uid, err);
    return null;
  }
}

function mapFirebaseError(code: string): string {
  switch (code) {
    case 'auth/invalid-email':
      return 'Enter a valid email address.';
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
      return 'Incorrect email or password.';
    case 'auth/user-not-found':
      return 'No account found for this email.';
    case 'auth/too-many-requests':
      return 'Too many attempts. Try again shortly.';
    case 'auth/network-request-failed':
      return 'Network error. Check your connection.';
    default:
      return 'Login failed. Please try again.';
  }
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  initializing: true,
  error: null,

  login: async (email, password) => {
    set({ error: null });
    try {
      const cred = await signInWithEmailAndPassword(auth, email.trim(), password);
      const profile = await resolveProfile(cred.user.uid);

      if (profile && !profile.active) {
        await signOut(auth);
        set({ error: 'This account has been deactivated. Contact your admin.' });
        return false;
      }

      set({
        user: {
          uid: cred.user.uid,
          email: cred.user.email,
          name: profile?.name ?? null,
          role: profile?.role ?? 'supervisor',
          assign: profile?.assign ?? null,
        },
      });
      return true;
    } catch (err: any) {
      console.error('[login] Firebase Auth error:', err.code, err.message);
      set({ error: mapFirebaseError(err.code) });
      return false;
    }
  },

  logout: async () => {
    await signOut(auth);
    set({ user: null });
  },

  clearError: () => set({ error: null }),
}));

// Keeps the store in sync on cold start if Firebase has a cached session.
onAuthStateChanged(auth, async (fbUser: FirebaseUser | null) => {
  if (!fbUser) {
    useAuthStore.setState({ user: null, initializing: false });
    return;
  }
  const profile = await resolveProfile(fbUser.uid);

  if (profile && !profile.active) {
    await signOut(auth);
    useAuthStore.setState({ user: null, initializing: false, error: 'This account has been deactivated. Contact your admin.' });
    return;
  }

  useAuthStore.setState({
    user: {
      uid: fbUser.uid,
      email: fbUser.email,
      name: profile?.name ?? null,
      role: profile?.role ?? 'supervisor',
      assign: profile?.assign ?? null,
    },
    initializing: false,
  });
});