// src/services/endProductionSession.ts
//
// Firestore wiring for the admin "End Production" action — the logic and
// its rules are in src/utils/endProduction.ts.

import { doc, runTransaction, serverTimestamp } from 'firebase/firestore';
import { db } from './firebase';
import {
  EndProductionActor,
  EndProductionTarget,
  EndProductionTx,
  RunTransaction,
  endProductionSession,
} from '../utils/endProduction';

const runFirestoreTransaction: RunTransaction = (fn) =>
  runTransaction(db, (t) => {
    const tx: EndProductionTx = {
      get: async (path) => {
        const snap = await t.get(doc(db, path));
        return { exists: snap.exists(), data: snap.exists() ? (snap.data() as Record<string, any>) : null };
      },
      set: (path, data) => { t.set(doc(db, path), data); },
      delete: (path) => { t.delete(doc(db, path)); },
    };
    return fn(tx);
  });

export function adminEndProductionSession(target: EndProductionTarget, actor: EndProductionActor) {
  return endProductionSession(runFirestoreTransaction, target, actor, () => ({ endedAt: serverTimestamp(), nowMs: Date.now() }));
}
