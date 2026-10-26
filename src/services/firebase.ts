import { initializeApp, getApps, getApp } from 'firebase/app';
import { initializeAuth, getAuth, getReactNativePersistence, Auth } from 'firebase/auth';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getFirestore } from 'firebase/firestore';
import { getFunctions, connectFunctionsEmulator } from 'firebase/functions';
import { Platform } from 'react-native';

// Paste the config object from:
// Firebase Console -> Project settings -> General -> Your apps -> Web app
const firebaseConfig = {
  apiKey: "AIzaSyACxBTtfBEd-arlttHfc4lg4O1Pjyx7VUw",
  authDomain: "technico-industries-ltd.firebaseapp.com",
  projectId: "technico-industries-ltd",
  storageBucket: "technico-industries-ltd.firebasestorage.app",
  messagingSenderId: "281455614052",
  appId: "1:281455614052:web:c3396380547310fa686771",
  measurementId: "G-706QLLBLQ1"
};

const app = getApps().length ? getApp() : initializeApp(firebaseConfig);

// initializeAuth must only run once — Expo's fast refresh can re-run this
// module, so we fall back to getAuth() if it's already initialized.
let auth: Auth;
try {
  auth = initializeAuth(app, {
    persistence: getReactNativePersistence(AsyncStorage),
  });
} catch {
  auth = getAuth(app);
}

const db = getFirestore(app);

// Used by src/services/prodPulseAI.ts to call the secure Cloud Function
// backend (Part 3) — no AI key or Firestore query logic lives on the
// client, only this callable-function client.
const functions = getFunctions(app);

// Dev-only, opt-in: point the Functions client at the local emulator
// (`npm --prefix functions run serve`) instead of production. Set
// EXPO_PUBLIC_USE_FUNCTIONS_EMULATOR=1 in .env.local to enable it — it used
// to be always on in dev, so every dev build called an emulator that was
// usually not running. Wrapped in try/catch because Expo's fast refresh can
// re-run this module, and connecting twice throws.
// NOTE: an Android emulator reaches the host as 10.0.2.2; a physical device
// needs your machine's LAN IP.
if (__DEV__ && process.env.EXPO_PUBLIC_USE_FUNCTIONS_EMULATOR === '1') {
  try {
    const emulatorHost = Platform.OS === 'android' ? '10.0.2.2' : '127.0.0.1';
    connectFunctionsEmulator(functions, emulatorHost, 5001);
  } catch {
    // already connected to the emulator — fast refresh re-ran this module
  }
}

export { app, auth, db, functions, firebaseConfig };