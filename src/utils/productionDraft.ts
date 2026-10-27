// src/utils/productionDraft.ts
//
// Pure helpers behind RecordProductionScreen's session sync, draft
// persistence and restore. Kept free of React/Firebase so it can be checked
// by scripts/testProductionDraft.ts (npm run test:production-draft).
//
// WHERE A SESSION'S DATA LIVES
//   1. activeSessions/{lineId} (Firestore) — the shared copy every device
//      loads. Carries a `revision` that every sync bumps by one, inside a
//      transaction that reads the current revision first.
//   2. A local draft (AsyncStorage — localStorage on web) — this device's
//      recovery copy ONLY, never visible to another device. Holds the last
//      server copy this device synced (`base` at `baseRevision`) and the
//      device's own edits on top (`local`). Removed once the server has
//      confirmed those edits.
//   3. productionRecords — what Save Slot / Finalize wrote. Fills values that
//      are still missing on restore; never overrides an entered value.
//
// CONFLICTS (threeWayMerge): when the server has moved past the revision a
// device's edits were based on, each value is merged against that base:
// changed on one side only → that change is kept; changed on both sides to
// different values → the SERVER value is kept (an older local copy never
// silently overwrites newer server data) and the other value is preserved as
// a SyncConflict on the session doc, shown to the supervisor with a "use
// this value" action. Exceptions: a stop closed on either side stays closed,
// and values the supervisor just explicitly saved (Save Slot) win.

// ─── Production record identity (moved unchanged from RecordProductionScreen) ─

export type SlotSegment = 'full' | 'before' | 'after';

export interface ProductionSlotIdentity {
  productionDate: string;
  lineId: string;
  shift: string;
  slotIndex: number;
  segment: SlotSegment;
}

// Deterministic doc ID. Each part is URI-encoded, so it can never contain
// '/' (illegal in an ID) or the '|' separator — distinct identities can't
// collide.
export function productionRecordId(id: ProductionSlotIdentity): string {
  return ['pr', id.productionDate, id.lineId, id.shift, String(id.slotIndex), id.segment]
    .map((v) => encodeURIComponent(v))
    .join('|');
}

// The fields of a production-record UPDATE: `keepWhenNull` fields that are
// null/undefined here are left out, so the merge keeps what is stored (used
// by Finalize so a reason missing from memory never erases a stored one).
export function fieldsForRecordUpdate(fields: Record<string, any>, keepWhenNull: string[] = []): Record<string, any> {
  const out: Record<string, any> = { ...fields };
  for (const k of keepWhenNull) if (out[k] == null) delete out[k];
  return out;
}

// ─── Session state ───────────────────────────────────────────────────────────

export interface StoredLossReason {
  code: string;
  label: string;
  note: string | null;
}

export interface StopLike {
  id?: string;
  reason: string;
  startAbs: number;
  endAbs?: number;
  durationMinutes?: number;
  running?: boolean;
  breakdownDocId?: string;
}

export interface SyncConflict {
  id: string;
  field: SyncField;
  key: string;            // map key ('3', '3:before', '<slot>|<stopId>'), '' for otHours/operators
  keptValue: unknown;     // what the session holds now
  otherValue: unknown;    // the value that was NOT kept — recoverable via "use this value"
  otherDeviceId: string | null;
  atMs: number;
}

// The slot-level values — the same keys the screen and the activeSessions
// doc use: producedBySlot by slot index, everything else by '<slot>' or
// '<slot>:before' / '<slot>:after'.
export interface SessionSlotData {
  producedBySlot: Record<string, number | null>;
  producedSegment: Record<string, number | null>;
  rejectionsBySlot: Record<string, number>;
  lossReasonBySlot: Record<string, StoredLossReason>;
  changeovers: Record<string, Record<string, unknown> | null>;
  deletedSlotIndices: number[];
  savedSlotIndices: number[];
}

// What a deleted hourly card held when it was deleted, kept in the session
// so the card can be restored (see utils/slotRecovery). Keyed by slot index.
export interface DeletedSlotBackup {
  slotIndex: number;
  deletedAtMs: number;
  label: string | null;
  startMinutesAbs: number | null;
  endMinutesAbs: number | null;
  produced: number | null;
  // Same keys as the session maps: '<slot>', '<slot>:before', '<slot>:after'.
  producedSegment: Record<string, number | null>;
  rejections: Record<string, number>;
  lossReasons: Record<string, StoredLossReason>;
  changeover: Record<string, unknown> | null;
  stops: StopLike[];
}

// Everything a device syncs through activeSessions.
export interface SyncState extends SessionSlotData {
  stopsBySlot: Record<string, StopLike[]>;
  // Optional on stored sessions/drafts (added later) — read as {}.
  deletedSlotBackups: Record<string, DeletedSlotBackup | null>;
  otHours: number;
  operators: { id?: string; name: string; code: string }[];
  // id → conflict, or null once dismissed (null wins, so a dismissal syncs).
  syncConflicts: Record<string, SyncConflict | null>;
}

export type SyncField =
  | 'producedBySlot' | 'producedSegment' | 'rejectionsBySlot' | 'lossReasonBySlot' | 'changeovers'
  | 'stopsBySlot' | 'otHours' | 'operators' | 'deletedSlotBackups';

export function emptySyncState(): SyncState {
  return {
    producedBySlot: {}, producedSegment: {}, rejectionsBySlot: {}, lossReasonBySlot: {}, changeovers: {},
    deletedSlotIndices: [], savedSlotIndices: [], stopsBySlot: {}, otHours: 0, operators: [], syncConflicts: {},
    deletedSlotBackups: {},
  };
}

// Firestore rejects `undefined`, and an optional note is undefined in the
// screen's state — normalize to null. Entries without a code are dropped.
export function serializeLossReasons(
  map: Record<string, { code: string; label: string; note?: string | null } | undefined>
): Record<string, StoredLossReason> {
  const out: Record<string, StoredLossReason> = {};
  for (const [k, v] of Object.entries(map ?? {})) {
    if (!v || typeof v.code !== 'string' || !v.code) continue;
    out[k] = { code: v.code, label: typeof v.label === 'string' ? v.label : v.code, note: v.note ? String(v.note) : null };
  }
  return out;
}

// Stops without undefined fields (Firestore rejects them).
export function serializeStops(stops: Record<string, StopLike[]>): Record<string, StopLike[]> {
  const out: Record<string, StopLike[]> = {};
  for (const [k, arr] of Object.entries(stops ?? {})) {
    out[k] = (Array.isArray(arr) ? arr : []).map((s) => {
      const c: Record<string, unknown> = {};
      for (const [f, v] of Object.entries(s)) if (v !== undefined) c[f] = v;
      return c as unknown as StopLike;
    });
  }
  return out;
}

// ─── Equality ────────────────────────────────────────────────────────────────

function stable(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) {
      const x = (v as Record<string, unknown>)[k];
      if (x !== undefined) out[k] = stable(x);
    }
    return out;
  }
  return v;
}

export function valuesEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(stable(a ?? null)) === JSON.stringify(stable(b ?? null));
}

const sortedIndices = (a: number[]) => Array.from(new Set(a)).sort((x, y) => x - y);

export function syncStatesEqual(a: SyncState, b: SyncState): boolean {
  return valuesEqual(
    { ...a, deletedSlotIndices: sortedIndices(a.deletedSlotIndices), savedSlotIndices: sortedIndices(a.savedSlotIndices) },
    { ...b, deletedSlotIndices: sortedIndices(b.deletedSlotIndices), savedSlotIndices: sortedIndices(b.savedSlotIndices) }
  );
}

// ─── Three-way merge ─────────────────────────────────────────────────────────

export interface MergeOptions {
  // Which side wins a true conflict (both changed the same value differently).
  prefer: 'remote' | 'local';
  // `${field}|${key}` values the local side wins regardless (Save Slot).
  preferLocalKeys?: Set<string>;
  // Recorded on conflicts.
  deviceId: string | null;
  nowMs: number;
  // Whether to record conflicts (a merge of the user's own newer typing
  // over a sync result isn't a conflict between devices).
  recordConflicts?: boolean;
}

export interface MergeResult {
  merged: SyncState;
  conflicts: SyncConflict[];
}

function mergeMap<V>(
  field: SyncField,
  base: Record<string, V>,
  local: Record<string, V>,
  remote: Record<string, V>,
  opts: MergeOptions,
  conflicts: SyncConflict[],
  resolve?: (l: V, r: V) => V | undefined
): Record<string, V> {
  const out: Record<string, V> = {};
  const keys = new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)]);
  const norm = (v: V | undefined) => (v === null ? undefined : v);
  for (const k of keys) {
    const b = norm(base[k]);
    const l = norm(local[k]);
    const r = norm(remote[k]);
    let v: V | undefined;
    if (valuesEqual(l, b)) v = r;
    else if (valuesEqual(r, b) || valuesEqual(l, r)) v = l;
    else {
      const special = resolve?.(l as V, r as V);
      if (special !== undefined) v = special;
      else {
        const localWins = opts.prefer === 'local' || !!opts.preferLocalKeys?.has(`${field}|${k}`);
        v = localWins ? l : r;
        if (opts.recordConflicts !== false) {
          conflicts.push({
            id: `${opts.deviceId ?? 'device'}-${opts.nowMs}-${conflicts.length}`,
            field, key: k,
            keptValue: (localWins ? l : r) ?? null,
            otherValue: (localWins ? r : l) ?? null,
            otherDeviceId: localWins ? null : opts.deviceId,
            atMs: opts.nowMs,
          });
        }
      }
    }
    if (v !== undefined) out[k] = v;
    else if (local[k] === null || remote[k] === null) out[k] = null as V; // keep an explicit "empty"
  }
  return out;
}

function mergeIndexSet(base: number[], local: number[], remote: number[]): number[] {
  const b = new Set(base), l = new Set(local), r = new Set(remote);
  const all = new Set([...b, ...l, ...r]);
  const out: number[] = [];
  all.forEach((i) => {
    const inLocal = l.has(i), inBase = b.has(i);
    if (inLocal !== inBase ? inLocal : r.has(i)) out.push(i);
  });
  return out.sort((x, y) => x - y);
}

function flattenStops(stops: Record<string, StopLike[]>): Record<string, StopLike> {
  const out: Record<string, StopLike> = {};
  for (const [slot, arr] of Object.entries(stops ?? {})) {
    for (const s of Array.isArray(arr) ? arr : []) out[`${slot}|${s.id ?? `stop-${s.startAbs}`}`] = s;
  }
  return out;
}

function groupStops(flat: Record<string, StopLike>): Record<string, StopLike[]> {
  const out: Record<string, StopLike[]> = {};
  for (const [k, s] of Object.entries(flat)) {
    if (!s) continue;
    const slot = k.slice(0, k.indexOf('|'));
    (out[slot] ??= []).push(s);
  }
  for (const arr of Object.values(out)) arr.sort((a, b) => a.startAbs - b.startAbs);
  return out;
}

export function threeWayMerge(base: SyncState, local: SyncState, remote: SyncState, opts: MergeOptions): MergeResult {
  const conflicts: SyncConflict[] = [];
  const scalar = <V>(field: SyncField, b: V, l: V, r: V): V => {
    const m = mergeMap<V>(field, { '': b }, { '': l }, { '': r }, opts, conflicts);
    return m[''] as V;
  };
  const merged: SyncState = {
    producedBySlot: mergeMap('producedBySlot', base.producedBySlot, local.producedBySlot, remote.producedBySlot, opts, conflicts),
    producedSegment: mergeMap('producedSegment', base.producedSegment, local.producedSegment, remote.producedSegment, opts, conflicts),
    rejectionsBySlot: mergeMap('rejectionsBySlot', base.rejectionsBySlot, local.rejectionsBySlot, remote.rejectionsBySlot, opts, conflicts),
    lossReasonBySlot: mergeMap('lossReasonBySlot', base.lossReasonBySlot, local.lossReasonBySlot, remote.lossReasonBySlot, opts, conflicts),
    changeovers: mergeMap('changeovers', base.changeovers, local.changeovers, remote.changeovers, opts, conflicts),
    deletedSlotIndices: mergeIndexSet(base.deletedSlotIndices, local.deletedSlotIndices, remote.deletedSlotIndices),
    savedSlotIndices: mergeIndexSet(base.savedSlotIndices, local.savedSlotIndices, remote.savedSlotIndices),
    // A stop interval closed on either device stays closed — a resume is
    // never undone by the other device's older "still running" copy.
    stopsBySlot: groupStops(
      mergeMap('stopsBySlot', flattenStops(base.stopsBySlot), flattenStops(local.stopsBySlot), flattenStops(remote.stopsBySlot), opts, conflicts,
        (l, r) => {
          if (l && r && l.running && !r.running) return r;
          if (l && r && r.running && !l.running) return l;
          return undefined;
        })
    ),
    deletedSlotBackups: mergeMap('deletedSlotBackups', base.deletedSlotBackups ?? {}, local.deletedSlotBackups ?? {}, remote.deletedSlotBackups ?? {}, opts, conflicts),
    otHours: scalar('otHours', base.otHours, local.otHours, remote.otHours) ?? 0,
    operators: scalar('operators', base.operators, local.operators, remote.operators) ?? [],
    // Conflict entries: union; a dismissal (null) on either side wins.
    syncConflicts: (() => {
      const out: Record<string, SyncConflict | null> = { ...remote.syncConflicts };
      for (const [id, c] of Object.entries(local.syncConflicts)) {
        if (c === null || !(id in out)) out[id] = c;
      }
      return out;
    })(),
  };
  for (const c of conflicts) merged.syncConflicts[c.id] = c;
  return { merged, conflicts };
}

// What one device's sync writes, given the session doc it just read in its
// transaction. Server still at this device's base revision → the local state
// as is; otherwise a three-way merge in which the server value wins a clash
// (except preferLocalKeys). The result is written at remote revision + 1.
export function planSessionSync(
  base: { revision: number; state: SyncState } | null,
  local: SyncState,
  remote: { revision: number; state: SyncState },
  opts: { preferLocalKeys?: Set<string>; deviceId: string | null; nowMs: number }
): { merged: SyncState; revision: number; conflicts: SyncConflict[] } {
  if (base && remote.revision === base.revision) return { merged: local, revision: remote.revision + 1, conflicts: [] };
  const m = threeWayMerge(base?.state ?? remote.state, local, remote.state, {
    prefer: 'remote', preferLocalKeys: opts.preferLocalKeys, deviceId: opts.deviceId, nowMs: opts.nowMs,
  });
  return { merged: m.merged, revision: remote.revision + 1, conflicts: m.conflicts };
}

// Whether a device may still write its session doc, given what its sync
// transaction (or listener) just read: gone → 'finalized' (Finalize, or an
// admin's End Production, deleted it), another run of the line's session →
// 'replaced', else null. A device never re-creates a gone session doc —
// only Start Production does.
export function sessionWriteGate(
  remote: { exists: boolean; sessionInstanceId?: string | null },
  localInstance: string | null
): 'finalized' | 'replaced' | null {
  if (!remote.exists) return 'finalized';
  if (localInstance && remote.sessionInstanceId && remote.sessionInstanceId !== localInstance) return 'replaced';
  return null;
}

// ─── Local draft ─────────────────────────────────────────────────────────────

export const DRAFT_VERSION = 2;
const DRAFT_KEY_PREFIX = 'prodpulse.productionDraft.v2';

export interface DraftScope {
  uid: string;
  lineId: string;
  productionDate: string;
  shift: string;
  // Which run of the line's session this is: activeSessions.sessionInstanceId,
  // or `startedAt:<ms>` for sessions started before that field existed. A
  // draft of an earlier (finalized) session on the same line/date/shift never
  // matches a new one.
  sessionInstance: string;
}

export interface ProductionDraft extends DraftScope {
  version: 2;
  updatedAtMs: number;
  // This device's edit counter when the draft was written.
  revision: number;
  // The server copy this device last synced, and its activeSessions revision.
  baseRevision: number;
  base: SyncState;
  // This device's state (base + its not-yet-synced edits).
  local: SyncState;
}

// One key per user + line + date + shift, so another supervisor on a shared
// device, another line or another shift can never load this draft.
export function draftStorageKey(scope: Omit<DraftScope, 'sessionInstance'>): string {
  return [DRAFT_KEY_PREFIX, scope.uid, scope.lineId, scope.productionDate, scope.shift]
    .map((v) => encodeURIComponent(v))
    .join('|');
}

export function isCompleteScope(scope: Partial<DraftScope> | null | undefined): scope is DraftScope {
  return !!scope && !!scope.uid && !!scope.lineId && !!scope.productionDate && !!scope.shift && !!scope.sessionInstance;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

function cleanQuantities(v: unknown): Record<string, number | null> | null {
  if (!isPlainObject(v)) return null;
  const out: Record<string, number | null> = {};
  for (const [k, q] of Object.entries(v)) {
    if (q === null || isCount(q)) out[k] = q;
    else return null;
  }
  return out;
}

function cleanIndexList(v: unknown): number[] | null {
  if (!Array.isArray(v)) return null;
  return v.every((n) => Number.isInteger(n) && n >= 0) ? (v as number[]) : null;
}

function cleanChangeovers(v: unknown): Record<string, Record<string, unknown> | null> | null {
  if (!isPlainObject(v)) return null;
  const out: Record<string, Record<string, unknown> | null> = {};
  for (const [k, co] of Object.entries(v)) {
    if (co === null) { out[k] = null; continue; }
    if (
      !isPlainObject(co) ||
      !Number.isInteger(co.slotIndex) ||
      typeof co.atAbs !== 'number' ||
      !Number.isInteger(co.oldPartIndex) ||
      !Number.isInteger(co.newPartIndex)
    ) return null; // a damaged changeover would change slot structure — reject the draft
    out[k] = co;
  }
  return out;
}

function cleanStops(v: unknown): Record<string, StopLike[]> | null {
  if (!isPlainObject(v)) return null;
  const out: Record<string, StopLike[]> = {};
  for (const [k, arr] of Object.entries(v)) {
    if (!Array.isArray(arr)) return null;
    if (!arr.every((s) => isPlainObject(s) && typeof s.startAbs === 'number' && typeof s.reason === 'string')) return null;
    out[k] = arr as StopLike[];
  }
  return out;
}

// Backups are a recovery aid, never slot structure: a damaged entry is
// dropped instead of rejecting the whole draft.
export function cleanDeletedSlotBackups(v: unknown): Record<string, DeletedSlotBackup | null> {
  if (!isPlainObject(v)) return {};
  const out: Record<string, DeletedSlotBackup | null> = {};
  for (const [k, b] of Object.entries(v)) {
    if (b === null) { out[k] = null; continue; }
    if (
      !isPlainObject(b) || !Number.isInteger(b.slotIndex) || String(b.slotIndex) !== k ||
      typeof b.deletedAtMs !== 'number'
    ) continue;
    const quantities = cleanQuantities(b.producedSegment ?? {});
    const rejections = cleanQuantities(b.rejections ?? {});
    const stops = cleanStops({ s: b.stops ?? [] });
    if (!quantities || !rejections || !stops) continue;
    if (b.changeover != null && cleanChangeovers({ c: b.changeover }) === null) continue;
    const rej: Record<string, number> = {};
    for (const [rk, n] of Object.entries(rejections)) if (n != null) rej[rk] = n;
    out[k] = {
      slotIndex: b.slotIndex as number,
      deletedAtMs: b.deletedAtMs,
      label: typeof b.label === 'string' ? b.label : null,
      startMinutesAbs: typeof b.startMinutesAbs === 'number' ? b.startMinutesAbs : null,
      endMinutesAbs: typeof b.endMinutesAbs === 'number' ? b.endMinutesAbs : null,
      produced: isCount(b.produced) ? b.produced : null,
      producedSegment: quantities,
      rejections: rej,
      lossReasons: serializeLossReasons(isPlainObject(b.lossReasons) ? (b.lossReasons as any) : {}),
      changeover: (b.changeover as Record<string, unknown> | null | undefined) ?? null,
      stops: stops.s,
    };
  }
  return out;
}

// Validates a stored SyncState; null if anything is off.
export function cleanSyncState(v: unknown): SyncState | null {
  if (!isPlainObject(v)) return null;
  const producedBySlot = cleanQuantities(v.producedBySlot);
  const producedSegment = cleanQuantities(v.producedSegment);
  const rejections = cleanQuantities(v.rejectionsBySlot ?? {});
  const changeovers = cleanChangeovers(v.changeovers ?? {});
  const deletedSlotIndices = cleanIndexList(v.deletedSlotIndices ?? []);
  const savedSlotIndices = cleanIndexList(v.savedSlotIndices ?? []);
  const stopsBySlot = cleanStops(v.stopsBySlot ?? {});
  if (
    !producedBySlot || !producedSegment || !rejections || !changeovers || !deletedSlotIndices || !savedSlotIndices || !stopsBySlot ||
    !isPlainObject(v.lossReasonBySlot ?? {}) || !isCount(v.otHours ?? 0) || !Array.isArray(v.operators ?? []) ||
    !isPlainObject(v.syncConflicts ?? {})
  ) return null;
  const rejectionsBySlot: Record<string, number> = {};
  for (const [k, n] of Object.entries(rejections)) if (n != null) rejectionsBySlot[k] = n;
  return {
    producedBySlot, producedSegment, rejectionsBySlot,
    lossReasonBySlot: serializeLossReasons((v.lossReasonBySlot ?? {}) as any),
    changeovers, deletedSlotIndices, savedSlotIndices, stopsBySlot,
    otHours: (v.otHours as number) ?? 0,
    operators: (v.operators as SyncState['operators']) ?? [],
    syncConflicts: (v.syncConflicts as SyncState['syncConflicts']) ?? {},
    deletedSlotBackups: cleanDeletedSlotBackups(v.deletedSlotBackups),
  };
}

export type DraftParseResult =
  | { ok: true; draft: ProductionDraft }
  | { ok: false; reason: 'missing' | 'malformed' | 'version' | 'scope' };

// Validates a stored draft against the session being opened. Anything that
// is not exactly a current-version draft of this scope is rejected — never
// partially used.
export function parseDraft(raw: string | null | undefined, scope: DraftScope): DraftParseResult {
  if (raw == null || raw === '') return { ok: false, reason: 'missing' };
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (!isPlainObject(v)) return { ok: false, reason: 'malformed' };
  if (v.version !== DRAFT_VERSION) return { ok: false, reason: 'version' };
  if (
    v.uid !== scope.uid ||
    v.lineId !== scope.lineId ||
    v.productionDate !== scope.productionDate ||
    v.shift !== scope.shift ||
    v.sessionInstance !== scope.sessionInstance
  ) return { ok: false, reason: 'scope' };
  const base = cleanSyncState(v.base);
  const local = cleanSyncState(v.local);
  if (!base || !local || !isCount(v.updatedAtMs) || !isCount(v.revision) || !isCount(v.baseRevision)) {
    return { ok: false, reason: 'malformed' };
  }
  return {
    ok: true,
    draft: { version: 2, ...scope, updatedAtMs: v.updatedAtMs, revision: v.revision, baseRevision: v.baseRevision, base, local },
  };
}

export function createDraft(
  scope: DraftScope,
  base: SyncState,
  baseRevision: number,
  local: SyncState,
  updatedAtMs: number,
  revision: number
): ProductionDraft {
  return { version: 2, ...scope, updatedAtMs, revision, baseRevision, base, local };
}

// The subset of AsyncStorage the draft needs — injectable for tests. On
// web, AsyncStorage is window.localStorage (written synchronously inside the
// returned promise), scoped to this browser profile and origin.
export interface DraftStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export async function saveDraft(storage: DraftStorage, draft: ProductionDraft): Promise<boolean> {
  try {
    await storage.setItem(draftStorageKey(draft), JSON.stringify(draft));
    return true;
  } catch {
    return false;
  }
}

export async function loadDraft(storage: DraftStorage, scope: DraftScope): Promise<DraftParseResult> {
  try {
    return parseDraft(await storage.getItem(draftStorageKey(scope)), scope);
  } catch {
    return { ok: false, reason: 'malformed' };
  }
}

// Removes the draft only if it is not newer than `confirmedRevision` — a
// draft written for a later edit (still unconfirmed) is kept.
export async function retireDraft(storage: DraftStorage, scope: DraftScope, confirmedRevision: number): Promise<boolean> {
  try {
    const key = draftStorageKey(scope);
    const parsed = parseDraft(await storage.getItem(key), scope);
    if (parsed.ok && parsed.draft.revision > confirmedRevision) return false;
    if (parsed.ok || parsed.reason !== 'missing') await storage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

// Every draft operation for one storage, run one after another. A retire is
// a read + remove; serialized, a newer draft saved meanwhile can't be removed
// by an older retire that read the store before it was written.
export interface DraftStore {
  save(draft: ProductionDraft): Promise<boolean>;
  load(scope: DraftScope): Promise<DraftParseResult>;
  retire(scope: DraftScope, confirmedRevision: number): Promise<boolean>;
}

export function createDraftStore(storage: DraftStorage): DraftStore {
  let tail: Promise<unknown> = Promise.resolve();
  const run = <T>(op: () => Promise<T>): Promise<T> => {
    const p = tail.then(op, op);
    tail = p.catch(() => undefined);
    return p;
  };
  return {
    save: (draft) => run(() => saveDraft(storage, draft)),
    load: (scope) => run(() => loadDraft(storage, scope)),
    retire: (scope, rev) => run(() => retireDraft(storage, scope, rev)),
  };
}

// ─── Restore: server copy + local draft + productionRecords ─────────────────

export interface RestoreRecord {
  id: string;
  slotIndex: number | null;
  partSegment: 'before' | 'after' | null;
  producedThisSlot: number | null;
  rejections: number | null;
  lossReasonCode: string | null;
  lossReasonLabel: string | null;
  lossReasonNote: string | null;
  createdAtMs: number | null;
  updatedAtMs: number | null;
}

// Records written before this session instance started belong to an earlier
// run on the same line/date/shift and are not used to fill this one. Both
// times are server timestamps; the grace only absorbs rounding.
const SESSION_START_GRACE_MS = 60_000;

// Per slot + segment, the doc Save Slot itself would update
// (resolveProductionRecordRef): the canonical-ID doc, else the
// earliest-created legacy one. A 'before' + 'after' pair is two segments of
// one slot, never a duplicate.
export function pickSlotRecords(
  records: RestoreRecord[],
  identity: { productionDate: string; lineId: string; shift: string },
  sessionStartedAtMs: number | null
): Map<number, Partial<Record<SlotSegment, RestoreRecord>>> {
  const groups = new Map<string, RestoreRecord[]>();
  for (const r of records) {
    if (!Number.isInteger(r.slotIndex)) continue;
    const at = r.updatedAtMs ?? r.createdAtMs;
    if (sessionStartedAtMs != null && (at == null || at < sessionStartedAtMs - SESSION_START_GRACE_MS)) continue;
    const seg: SlotSegment = r.partSegment ?? 'full';
    const key = `${r.slotIndex}|${seg}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const out = new Map<number, Partial<Record<SlotSegment, RestoreRecord>>>();
  groups.forEach((docs, key) => {
    const [idxStr, seg] = key.split('|') as [string, SlotSegment];
    const slotIndex = Number(idxStr);
    const canonical = productionRecordId({ ...identity, slotIndex, segment: seg });
    const chosen =
      docs.find((d) => d.id === canonical) ??
      [...docs].sort((a, b) => (a.createdAtMs ?? 0) - (b.createdAtMs ?? 0) || a.id.localeCompare(b.id))[0];
    out.set(slotIndex, { ...(out.get(slotIndex) ?? {}), [seg]: chosen });
  });
  return out;
}

// Fills values still missing from saved records and decides saved status.
// A slot counts as saved only when a record of its current shape exists
// (one 'full', or 'before' + 'after') — and it was marked saved, or the
// record holds exactly the value shown. Mutates `data`; returns fill count.
export function fillFromRecords(
  data: SessionSlotData,
  records: RestoreRecord[],
  identity: { productionDate: string; lineId: string; shift: string },
  sessionStartedAtMs: number | null,
  split: Set<number>
): number {
  let filled = 0;
  const marked = new Set(data.savedSlotIndices);
  const deleted = new Set(data.deletedSlotIndices);
  const bySlot = pickSlotRecords(records, identity, sessionStartedAtMs);
  const saved: number[] = [];

  const fillReason = (key: string, r: RestoreRecord) => {
    if (!data.lossReasonBySlot[key] && r.lossReasonCode) {
      data.lossReasonBySlot[key] = { code: r.lossReasonCode, label: r.lossReasonLabel ?? r.lossReasonCode, note: r.lossReasonNote ?? null };
      filled++;
    }
  };
  const fillRejections = (key: string, r: RestoreRecord) => {
    if (!(key in data.rejectionsBySlot) && isCount(r.rejections)) {
      data.rejectionsBySlot[key] = r.rejections;
      filled++;
    }
  };
  const fillQuantity = (map: Record<string, number | null>, key: string, r: RestoreRecord): boolean => {
    if (map[key] == null && isCount(r.producedThisSlot)) {
      map[key] = r.producedThisSlot;
      filled++;
    }
    return map[key] === r.producedThisSlot;
  };

  bySlot.forEach((segs, i) => {
    if (deleted.has(i)) return; // deleted card — left exactly as it is
    if (!split.has(i)) {
      const r = segs.full;
      if (!r) return;
      const matches = fillQuantity(data.producedBySlot, String(i), r);
      fillRejections(String(i), r);
      fillReason(String(i), r);
      if (marked.has(i) || matches) saved.push(i);
    } else {
      const b = segs.before;
      const a = segs.after;
      let matches = !!(b && a);
      if (b) { matches = fillQuantity(data.producedSegment, `${i}:before`, b) && matches; fillRejections(`${i}:before`, b); fillReason(`${i}:before`, b); }
      if (a) { matches = fillQuantity(data.producedSegment, `${i}:after`, a) && matches; fillRejections(`${i}:after`, a); fillReason(`${i}:after`, a); }
      if (b && a && (marked.has(i) || matches)) saved.push(i);
    }
  });
  // A marker with no record of the slot's current shape is dropped, so
  // Finalize writes that slot (to the same identity — never a second doc).
  data.savedSlotIndices = saved.sort((x, y) => x - y);
  return filled;
}

export interface RestoreInput {
  // The session as stored on the server, and its revision (0 = never synced
  // with a revision, i.e. an older session doc).
  server: SyncState;
  serverRevision: number;
  draft: ProductionDraft | null;
  // null = the records could not be loaded — saved markers are then trusted as stored.
  records: RestoreRecord[] | null;
  identity: { productionDate: string; lineId: string; shift: string };
  sessionStartedAtMs: number | null;
  // Slots split into BEFORE/AFTER by the given changeovers.
  splitSlotsFor: (changeovers: SessionSlotData['changeovers']) => Set<number>;
  deviceId: string | null;
  nowMs: number;
}

export interface RestoreResult {
  state: SyncState;
  // Base for this device's next sync: the server copy as loaded.
  base: SyncState;
  baseRevision: number;
  // The draft held edits that weren't on the server, and they were applied.
  draftApplied: boolean;
  // Draft edits that clashed with newer server values (server value kept).
  conflicts: SyncConflict[];
  filledFromRecords: number;
  // `state` differs from the server copy, so it should be synced.
  needsSync: boolean;
}

// Precedence: the server copy is the baseline. A draft's edits apply only
// as edits ON TOP of the server revision they were based on — if the server
// has moved on since (another device synced), they are three-way merged and
// a clash keeps the server value (recorded as a conflict). Records then fill
// what is still missing.
export function resolveRestore(input: RestoreInput): RestoreResult {
  const { server, draft } = input;
  let state: SyncState = JSON.parse(JSON.stringify(server));
  let conflicts: SyncConflict[] = [];
  let draftApplied = false;
  if (draft && !syncStatesEqual(draft.base, draft.local)) {
    if (draft.baseRevision === input.serverRevision) {
      state = JSON.parse(JSON.stringify(draft.local));
    } else {
      const m = threeWayMerge(draft.base, draft.local, server, { prefer: 'remote', deviceId: input.deviceId, nowMs: input.nowMs });
      state = m.merged;
      conflicts = m.conflicts;
    }
    draftApplied = true;
  }
  let filled = 0;
  if (input.records) {
    filled = fillFromRecords(state, input.records, input.identity, input.sessionStartedAtMs, input.splitSlotsFor(state.changeovers));
  }
  return {
    state,
    base: server,
    baseRevision: input.serverRevision,
    draftApplied,
    conflicts,
    filledFromRecords: filled,
    needsSync: !syncStatesEqual(state, server),
  };
}

// ─── Session write queue ─────────────────────────────────────────────────────
//
// Session writes run one at a time, in request order. A job builds its
// snapshot only when it starts — from the screen's current-state refs — so
// the newest state always wins and an older snapshot can never land after a
// newer one. Requests for the "latest state" made while one is already
// waiting share it (it will read the newest state anyway). Before each job
// the queue yields one macrotask, so code awaiting the previous job's result
// runs before the next snapshot is built.

export interface SessionWriteQueue {
  // Write whatever the current state is. Coalesces with a waiting request.
  latest(job: () => Promise<boolean>): Promise<boolean>;
  // A write that must run as its own job (e.g. with explicit overrides).
  explicit(job: () => Promise<boolean>): Promise<boolean>;
  // Resolves once every job queued so far has settled.
  idle(): Promise<void>;
  // True while a job is running or waiting.
  busy(): boolean;
}

const nextMacrotask = () => new Promise<void>((r) => setTimeout(r, 0));

export function createSessionWriteQueue(): SessionWriteQueue {
  let tail: Promise<unknown> = Promise.resolve();
  let waitingLatest: Promise<boolean> | null = null;
  let pending = 0;

  const run = (job: () => Promise<boolean>, onStart?: () => void): Promise<boolean> => {
    pending++;
    const p = tail.then(nextMacrotask).then(() => {
      onStart?.();
      return job();
    }).catch(() => false).finally(() => { pending--; });
    tail = p;
    return p;
  };

  return {
    latest(job) {
      if (waitingLatest) return waitingLatest;
      const p = run(job, () => { waitingLatest = null; });
      waitingLatest = p;
      return p;
    },
    explicit(job) {
      return run(job);
    },
    async idle() {
      await tail;
    },
    busy() {
      return pending > 0;
    },
  };
}

// Rejects after `ms` (the underlying operation is NOT cancelled). Used so a
// write that never settles while offline can't block the screen forever.
export function withTimeout<T>(p: Promise<T>, ms: number, label = 'operation'): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

// Retry delay after `failures` consecutive failed syncs: 5s, 10s, 20s, 40s,
// then every 60s.
export function syncRetryDelayMs(failures: number): number {
  return Math.min(60_000, 5_000 * 2 ** Math.max(0, failures - 1));
}
