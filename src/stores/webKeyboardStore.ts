// src/stores/webKeyboardStore.ts
//
// Web-only on-screen keyboard preference. Toggled from every dashboard (the
// hamburger drawer, or the header on the Technician/Restocker dashboards)
// and read by components/OnScreenKeyboard. Native apps ignore it: they
// already have the OS keyboard.
//
// Saved per USER (keyed by Firebase uid) in this browser's localStorage, so
// two people sharing one PC each keep their own choice. App.tsx calls
// setUser() whenever the signed-in user changes. While signed out (login
// screen) the last signed-in user's choice on this device applies, so a
// touch-screen kiosk that relies on the keyboard can still log back in.

import { Platform } from 'react-native';
import { create } from 'zustand';

const KEY_PREFIX = 'prodpulse.webKeyboard.v2.';
const LAST_USER_KEY = 'prodpulse.webKeyboard.v2.lastUser';

function storage(): Storage | null {
  if (Platform.OS !== 'web') return null;
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function read(key: string): string | null {
  try {
    return storage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function write(key: string, value: string) {
  try {
    storage()?.setItem(key, value);
  } catch {
    // Private window / blocked storage: the toggle still works this session.
  }
}

function enabledFor(uid: string | null): boolean {
  const who = uid ?? read(LAST_USER_KEY);
  return who ? read(KEY_PREFIX + who) === '1' : false;
}

interface WebKeyboardState {
  uid: string | null;
  enabled: boolean;
  setUser: (uid: string | null) => void;
  setEnabled: (enabled: boolean) => void;
  toggle: () => void;
}

export const useWebKeyboardStore = create<WebKeyboardState>((set, get) => ({
  uid: null,
  enabled: enabledFor(null),
  setUser: (uid) => {
    if (uid) write(LAST_USER_KEY, uid);
    set({ uid, enabled: enabledFor(uid) });
  },
  setEnabled: (enabled) => {
    const { uid } = get();
    set({ enabled });
    // The toggle lives on the dashboards, so a user is always signed in here.
    if (uid) write(KEY_PREFIX + uid, enabled ? '1' : '0');
  },
  toggle: () => get().setEnabled(!get().enabled),
}));
