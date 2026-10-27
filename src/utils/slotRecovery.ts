// src/utils/slotRecovery.ts
//
// Deleting and restoring an hourly card of Record Production.
//
// Deleting a card has always been a soft delete: its index goes into the
// session's deletedSlotIndices (the schedule itself — slot ids, indices,
// time ranges — never changes) and the values entered on it are cleared.
// Only unsaved cards can be deleted, so no productionRecords doc exists for
// one. What changed is that the cleared values are now kept in
// deletedSlotBackups[slotIndex] first, which syncs through activeSessions
// and the device draft like every other session field, so a deleted card
// can be restored after a refresh or on another device. A deletion made
// before backups existed has no backup, and is not offered for restore —
// nothing is ever re-created from guesses.

import {
  DeletedSlotBackup,
  StopLike,
  StoredLossReason,
  SyncState,
} from './productionDraft';
import { completeRunningStops, stopIdOf } from './downtime';

export interface DeletedSlotMeta {
  label: string | null;
  startMinutesAbs: number | null;
  endMinutesAbs: number | null;
}

const segmentKeys = (i: number) => [`${i}:before`, `${i}:after`];
const slotKeys = (i: number) => [String(i), ...segmentKeys(i)];

function pick<V>(map: Record<string, V>, keys: string[]): Record<string, V> {
  const out: Record<string, V> = {};
  for (const k of keys) if (k in map && map[k] !== undefined) out[k] = map[k];
  return out;
}

function omit<V>(map: Record<string, V>, keys: string[]): Record<string, V> {
  const out = { ...map };
  for (const k of keys) delete out[k];
  return out;
}

// The session after deleting slot `slotIndex`: exactly the values the delete
// always cleared are cleared, and a backup of them is stored. Deleting a slot
// that is already deleted changes nothing (its first backup is kept).
export function deleteSlotWithBackup(state: SyncState, slotIndex: number, meta: DeletedSlotMeta, nowMs: number): SyncState {
  if (state.deletedSlotIndices.includes(slotIndex)) return state;
  const key = String(slotIndex);
  const keys = slotKeys(slotIndex);
  const backup: DeletedSlotBackup = {
    slotIndex,
    deletedAtMs: nowMs,
    label: meta.label,
    startMinutesAbs: meta.startMinutesAbs,
    endMinutesAbs: meta.endMinutesAbs,
    produced: state.producedBySlot[key] ?? null,
    producedSegment: pick(state.producedSegment, segmentKeys(slotIndex)),
    rejections: pick(state.rejectionsBySlot, keys),
    lossReasons: pick(state.lossReasonBySlot, keys),
    changeover: state.changeovers[key] ?? null,
    stops: (state.stopsBySlot[key] ?? []).map((s) => ({ ...s })),
  };
  return {
    ...state,
    producedBySlot: omit(state.producedBySlot, [key]),
    producedSegment: omit(state.producedSegment, segmentKeys(slotIndex)),
    rejectionsBySlot: omit(state.rejectionsBySlot, keys),
    lossReasonBySlot: omit(state.lossReasonBySlot, keys),
    changeovers: omit(state.changeovers, [key]),
    stopsBySlot: omit(state.stopsBySlot, [key]),
    deletedSlotIndices: [...state.deletedSlotIndices, slotIndex].sort((a, b) => a - b),
    deletedSlotBackups: { ...(state.deletedSlotBackups ?? {}), [key]: backup },
  };
}

// Deleted slots that can be restored: still deleted, and with a backup.
export function restorableSlots(state: Pick<SyncState, 'deletedSlotIndices' | 'deletedSlotBackups'>): DeletedSlotBackup[] {
  const deleted = new Set(state.deletedSlotIndices);
  return Object.values(state.deletedSlotBackups ?? {})
    .filter((b): b is DeletedSlotBackup => !!b && deleted.has(b.slotIndex))
    .sort((a, b) => a.slotIndex - b.slotIndex);
}

export interface RestoreSlotResult {
  state: SyncState;
  restored: boolean;
  // Session keys that already held a value (entered after the delete, e.g.
  // on another device) — that newer value is kept, the backup's is not.
  keptCurrent: string[];
}

// The session after restoring slot `slotIndex` from its backup. The slot
// comes back with its own index (so its time range, ordering and record id
// are the original ones) and the values it held. A value entered for the
// same key since the delete is never overwritten. A stop is restored once
// (by its stable id); one that was still running when the card was deleted
// is closed at the delete time — the delete removed it, so the line has not
// been stopped on it since.
export function restoreDeletedSlot(state: SyncState, slotIndex: number): RestoreSlotResult {
  const key = String(slotIndex);
  const backup = state.deletedSlotBackups?.[key] ?? null;
  if (!backup || !state.deletedSlotIndices.includes(slotIndex)) return { state, restored: false, keptCurrent: [] };

  const keptCurrent: string[] = [];
  const fill = <V>(field: string, target: Record<string, V>, values: Record<string, V>): Record<string, V> => {
    const out = { ...target };
    for (const [k, v] of Object.entries(values)) {
      if (v === undefined || v === null) continue;
      if (out[k] !== undefined && out[k] !== null) { keptCurrent.push(`${field}:${k}`); continue; }
      out[k] = v;
    }
    return out;
  };

  const producedBySlot = fill('producedBySlot', state.producedBySlot, backup.produced != null ? { [key]: backup.produced } : {});
  const producedSegment = fill('producedSegment', state.producedSegment, backup.producedSegment ?? {});
  const rejectionsBySlot = fill<number>('rejectionsBySlot', state.rejectionsBySlot, backup.rejections ?? {});
  const lossReasonBySlot = fill<StoredLossReason>('lossReasonBySlot', state.lossReasonBySlot, backup.lossReasons ?? {});
  const changeovers = fill('changeovers', state.changeovers, backup.changeover ? { [key]: backup.changeover } : {});

  const existingStopIds = new Set(Object.values(state.stopsBySlot).flatMap((arr) => (arr ?? []).map((s) => stopIdOf(s))));
  const restoredStops: StopLike[] = completeRunningStops(
    (backup.stops ?? []).filter((s) => !existingStopIds.has(stopIdOf(s))),
    backup.deletedAtMs
  );
  const stopsBySlot = restoredStops.length
    ? { ...state.stopsBySlot, [key]: [...(state.stopsBySlot[key] ?? []), ...restoredStops].sort((a, b) => a.startAbs - b.startAbs) }
    : state.stopsBySlot;

  const deletedSlotBackups = { ...state.deletedSlotBackups };
  delete deletedSlotBackups[key];

  return {
    restored: true,
    keptCurrent,
    state: {
      ...state,
      producedBySlot,
      producedSegment,
      rejectionsBySlot,
      lossReasonBySlot,
      changeovers,
      stopsBySlot,
      deletedSlotIndices: state.deletedSlotIndices.filter((i) => i !== slotIndex),
      deletedSlotBackups,
    },
  };
}
