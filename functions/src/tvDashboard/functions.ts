// functions/src/tvDashboard/functions.ts
//
// Cloud Functions (v2) of the Assembly TV dashboard read model. Exported
// additively from ../index.ts; prodPulseAI is untouched.
//
//   tvDashboardOnActiveSession   activeSessions/{lineId}      → recompute that line
//   tvDashboardOnProductionRecord productionRecords/{recordId} → recompute its line (+ dirty past day)
//   tvDashboardOnShiftSummary    shiftSummaries/{summaryId}   → recompute its line (+ dirty past day)
//   tvDashboardOnEndedSession    endedSessions/{sessionId}    → recompute its line (+ dirty past day)
//   tvDashboardOnProductionLine  productionLines/{lineId}     → recompute that line (rename / move / delete)
//   tvDashboardOverview          every 1 minute (Asia/Kolkata) → today's day doc + overview
//   tvDashboardDaily             06:45 Asia/Kolkata           → rebuild the production date that ended at 06:30
//
// Region: asia-south1 — the location of the (default) Firestore database
// (confirmed by the owner), so the Firestore triggers run where their events
// originate. Set per function below, never through setGlobalOptions, so
// prodPulseAI keeps its own default region (us-central1, which the app's
// client calls).

import '../timezone'; // plant timezone before any date is computed (also imported first by ../index.ts)
import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { logger } from 'firebase-functions';
import { getFirestore } from 'firebase-admin/firestore';
import { DEFAULT_PRODUCTION_TIMEZONE } from '../timezone';
import { SourceCollection } from './core';
import { firestoreTvSources, firestoreTvStore } from './store';
import { TvDeps, finalizePreviousDay, handleSourceWrite, runOverview } from './service';

// Created on first use: ../index.ts calls initializeApp() after its imports.
let deps: TvDeps | null = null;
function tvDeps(): TvDeps {
  if (!deps) {
    const db = getFirestore();
    deps = {
      sources: firestoreTvSources(db),
      store: firestoreTvStore(db),
      now: () => Date.now(),
      log: (msg, meta) => logger.info(`[tvDashboard] ${msg}`, meta ?? {}),
      logError: (msg, meta) => logger.error(`[tvDashboard] ${msg}`, meta ?? {}),
    };
  }
  return deps;
}

// Same location as the (default) Firestore database. Applies to all seven
// TV dashboard functions; prodPulseAI is not affected.
// Not exported: ../index.ts re-exports this module with `export *`, and only
// Cloud Functions may appear there.
const TV_REGION = 'asia-south1';

const TRIGGER_OPTIONS = { region: TV_REGION, memory: '256MiB' as const, timeoutSeconds: 60, maxInstances: 10 };

function sourceTrigger(collection: SourceCollection, param: string) {
  return onDocumentWritten({ document: `${collection}/{${param}}`, ...TRIGGER_OPTIONS }, async (event) => {
    const docId = (event.params as Record<string, string>)[param];
    const before = event.data?.before?.exists ? (event.data.before.data() ?? null) : null;
    const after = event.data?.after?.exists ? (event.data.after.data() ?? null) : null;
    try {
      await handleSourceWrite(collection, docId, before, after, tvDeps());
    } catch (e) {
      // Not rethrown: retries are off by default and the overview's 15-minute
      // sweep re-derives every line from source anyway.
      logger.error(`[tvDashboard] ${collection}/${docId} failed`, { error: String(e) });
    }
  });
}

export const tvDashboardOnActiveSession = sourceTrigger('activeSessions', 'lineId');
export const tvDashboardOnProductionRecord = sourceTrigger('productionRecords', 'recordId');
export const tvDashboardOnShiftSummary = sourceTrigger('shiftSummaries', 'summaryId');
export const tvDashboardOnEndedSession = sourceTrigger('endedSessions', 'sessionId');
export const tvDashboardOnProductionLine = sourceTrigger('productionLines', 'lineId');

// concurrency: 1 — with the 2nd-gen default (80 when cpu ≥ 1) a run that
// outlasts its minute would overlap the next one inside the single instance.
// The generation guard already keeps overlapping results correct; this avoids
// the duplicate sweeps / day rebuilds.
export const tvDashboardOverview = onSchedule(
  { schedule: 'every 1 minutes', timeZone: DEFAULT_PRODUCTION_TIMEZONE, region: TV_REGION, retryCount: 0, maxInstances: 1, concurrency: 1, timeoutSeconds: 240, memory: '512MiB' },
  async () => {
    await runOverview(tvDeps());
  }
);

export const tvDashboardDaily = onSchedule(
  { schedule: '45 6 * * *', timeZone: DEFAULT_PRODUCTION_TIMEZONE, region: TV_REGION, retryCount: 2, maxInstances: 1, concurrency: 1, timeoutSeconds: 300, memory: '512MiB' },
  async () => {
    await finalizePreviousDay(tvDeps());
  }
);
