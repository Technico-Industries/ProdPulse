// src/utils/endProduction.ts
//
// Pure logic behind the admin "End Production" action on the Line
// Efficiency Overview (src/screens/LineEfficiencyOverviewScreen.tsx), and
// the supervisor side's view of it (RecordProductionScreen). Kept free of
// React/Firebase so it can be checked by scripts/testEndProduction.ts
// (npm run test:end-production); the Firestore wiring is in
// src/services/endProductionSession.ts.
//
// WHAT ENDING DOES — one transaction, nothing else:
//   1. read users/{adminUid}, activeSessions/{lineId} and the archive doc;
//   2. check the actor is an active admin, the session still exists, is the
//      same run of the line's session the dialog was opened for
//      (sessionInstanceId) and is still running (no stop in progress);
//   3. write the session doc, unchanged, plus end/audit fields to
//      endedSessions/{endedSessionId} and delete activeSessions/{lineId}.
// No productionRecords or shiftSummaries are written: unsaved slots are NOT
// submitted as production data (that only happens on the supervisor's own
// Finalize & End). Every value in the session — entered quantities,
// rejections, loss reasons, changeovers, stops, OT — stays in the archive,
// and saved productionRecords are never touched.
//
// Deleting the doc is the same "session ended" signal Finalize gives, so
// every supervisor screen and dashboard already reacts to it: listeners drop
// the line, and a supervisor device's next sync transaction finds the doc
// gone (sessionWriteGate) and stops instead of re-creating it.

export const ENDED_SESSIONS_COLLECTION = 'endedSessions';

export type EndProductionErrorCode =
  | 'not-signed-in'
  | 'not-admin'
  | 'not-active'   // no session any more (finalized / ended meanwhile)
  | 'replaced'     // a new session was started on the line meanwhile
  | 'line-stopped' // a stop started meanwhile — only running lines are ended
  | 'already-ended'
  | 'failed';

export class EndProductionError extends Error {
  constructor(public code: EndProductionErrorCode, message?: string) {
    super(message ?? code);
  }
}

// Which run of a line's session a doc is — the same rule RecordProduction's
// draft scope uses: sessionInstanceId, or `startedAt:<ms>` for sessions
// started before that field existed.
export function sessionInstanceOf(data: { sessionInstanceId?: unknown; startedAt?: unknown } | null | undefined): string | null {
  if (!data) return null;
  if (typeof data.sessionInstanceId === 'string' && data.sessionInstanceId) return data.sessionInstanceId;
  const ms = toMillis(data.startedAt);
  return ms != null ? `startedAt:${ms}` : null;
}

function toMillis(ts: unknown): number | null {
  if (typeof ts === 'number' && Number.isFinite(ts)) return ts;
  const t = ts as { toMillis?: () => number } | null;
  return t && typeof t.toMillis === 'function' ? t.toMillis() : null;
}

// One archive doc per run of a line's session. Each part is URI-encoded, so
// it can never contain '/' or the '|' separator.
export function endedSessionId(lineId: string, instance: string | null): string {
  return ['es', lineId, instance ?? 'unknown'].map((v) => encodeURIComponent(v)).join('|');
}

// Same rule as the session payload's lineStopped (any stop still running).
function anyStopRunning(stopsBySlot: unknown): boolean {
  if (!stopsBySlot || typeof stopsBySlot !== 'object') return false;
  return Object.values(stopsBySlot as Record<string, unknown>).some(
    (arr) => Array.isArray(arr) && arr.some((s) => !!s && (s as { running?: unknown }).running === true)
  );
}

export function isSessionRunning(session: Record<string, any>): boolean {
  return session.lineStopped !== true && !anyStopRunning(session.stopsBySlot);
}

// Same rule as authStore resolveProfile: role 'admin', and not deactivated.
export function isActiveAdmin(profile: Record<string, any> | null | undefined): boolean {
  return !!profile && profile.role === 'admin' && profile.active !== false;
}

export interface EndProductionTarget {
  lineId: string;
  lineName: string | null;
  // The run of the session the admin saw when opening the dialog.
  sessionInstance: string | null;
}

export interface EndProductionActor {
  uid: string | null;
  name: string | null;
  email: string | null;
}

export interface EndProductionReads {
  actorProfile: Record<string, any> | null;
  session: Record<string, any> | null;
  archiveExists: boolean;
}

// Decides, from the docs read inside the transaction, whether the session
// may be ended and what the archive doc holds. `endedAt` is the
// serverTimestamp() sentinel in the app, a number in tests.
export function planEndProduction(
  target: EndProductionTarget,
  actor: EndProductionActor,
  reads: EndProductionReads,
  stamps: { endedAt: unknown; nowMs: number }
): { ok: true; archiveId: string; archive: Record<string, any> } | { ok: false; code: EndProductionErrorCode } {
  if (!actor.uid) return { ok: false, code: 'not-signed-in' };
  if (!isActiveAdmin(reads.actorProfile)) return { ok: false, code: 'not-admin' };
  const s = reads.session;
  if (!s) return { ok: false, code: 'not-active' };
  const instance = sessionInstanceOf(s);
  if (target.sessionInstance && instance !== target.sessionInstance) return { ok: false, code: 'replaced' };
  if (!isSessionRunning(s)) return { ok: false, code: 'line-stopped' };
  if (reads.archiveExists) return { ok: false, code: 'already-ended' };
  return {
    ok: true,
    archiveId: endedSessionId(target.lineId, instance),
    archive: {
      ...s,
      sessionInstance: instance,
      sessionStatus: 'ended',
      endReason: 'admin_end',
      archivedFrom: `activeSessions/${target.lineId}`,
      endedAt: stamps.endedAt,
      endedAtClientMs: stamps.nowMs,
      endedBy: { uid: actor.uid, name: actor.name ?? null, email: actor.email ?? null, role: 'admin' },
    },
  };
}

// The transaction surface endProductionSession needs — Firestore's in the
// app (services/endProductionSession), an in-memory fake in tests.
export interface EndProductionTx {
  get(path: string): Promise<{ exists: boolean; data: Record<string, any> | null }>;
  set(path: string, data: Record<string, any>): void;
  delete(path: string): void;
}

export type RunTransaction = <T>(fn: (tx: EndProductionTx) => Promise<T>) => Promise<T>;

// Only reads and writes of the three docs above run inside the
// transaction — no other network work.
export async function endProductionSession(
  runTransaction: RunTransaction,
  target: EndProductionTarget,
  actor: EndProductionActor,
  stamps: () => { endedAt: unknown; nowMs: number }
): Promise<{ archiveId: string }> {
  if (!actor.uid) throw new EndProductionError('not-signed-in');
  return runTransaction(async (tx) => {
    const sessionPath = `activeSessions/${target.lineId}`;
    const [profile, session] = await Promise.all([tx.get(`users/${actor.uid}`), tx.get(sessionPath)]);
    const sessionData = session.exists ? session.data : null;
    const archiveId = endedSessionId(target.lineId, sessionInstanceOf(sessionData) ?? target.sessionInstance);
    const archive = await tx.get(`${ENDED_SESSIONS_COLLECTION}/${archiveId}`);
    const plan = planEndProduction(
      target,
      actor,
      { actorProfile: profile.exists ? profile.data : null, session: sessionData, archiveExists: archive.exists },
      stamps()
    );
    if (!plan.ok) throw new EndProductionError(plan.code);
    tx.set(`${ENDED_SESSIONS_COLLECTION}/${plan.archiveId}`, plan.archive);
    tx.delete(sessionPath);
    return { archiveId: plan.archiveId };
  });
}

export function endProductionErrorMessage(e: unknown): string {
  const code = e instanceof EndProductionError ? e.code : 'failed';
  switch (code) {
    case 'not-signed-in':
      return 'You are not signed in. Sign in again and retry.';
    case 'not-admin':
      return 'Only an active admin account can end production.';
    case 'not-active':
      return 'This line is no longer running — its session was already finalized or ended. Nothing was changed.';
    case 'replaced':
      return 'A new session was started on this line since you opened this. Nothing was changed — review the line and try again.';
    case 'line-stopped':
      return 'The line was stopped since you opened this. Nothing was changed — only running lines can be ended here.';
    case 'already-ended':
      return 'This session has already been ended. Nothing was changed.';
    default:
      return 'Could not end production (check your connection). Nothing was changed — try again.';
  }
}

// ─── Admin action flow (tap → confirm → end → message) ──────────────────────
// One request per line at a time: the line is marked busy from the tap,
// through the dialog, until the request settles — so a second tap (or a
// second dialog on native) can't start another transition.

export type EndProductionOutcome =
  | { kind: 'busy' }
  | { kind: 'cancelled' }
  | { kind: 'ended'; message: string }
  | { kind: 'error'; message: string };

export async function confirmAndEndProduction(
  target: EndProductionTarget,
  deps: {
    inFlight: Set<string>;
    confirm: (title: string, message: string) => Promise<boolean>;
    end: (target: EndProductionTarget) => Promise<unknown>;
    onBusyChange?: (lineId: string, busy: boolean) => void;
  }
): Promise<EndProductionOutcome> {
  if (deps.inFlight.has(target.lineId)) return { kind: 'busy' };
  deps.inFlight.add(target.lineId);
  deps.onBusyChange?.(target.lineId, true);
  try {
    const name = target.lineName || target.lineId;
    const ok = await deps.confirm(
      `End production for ${name}?`,
      'This will end the current production session for this line. Saved slot records are kept as they are. ' +
        'Slots that were not saved are NOT submitted as production records — the session\'s entries (quantities, ' +
        'rejections, loss reasons, changeovers, stops) are archived so they can be recovered.'
    );
    if (!ok) return { kind: 'cancelled' };
    try {
      await deps.end(target);
      return { kind: 'ended', message: `Production ended for ${name}. The session's entries were archived.` };
    } catch (e) {
      return { kind: 'error', message: endProductionErrorMessage(e) };
    }
  } finally {
    deps.inFlight.delete(target.lineId);
    deps.onBusyChange?.(target.lineId, false);
  }
}
