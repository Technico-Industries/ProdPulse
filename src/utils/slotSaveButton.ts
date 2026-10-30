// What a Record Production slot card's save button shows.
//
// `saved` must come from persisted data — the screen's savedSlotIndices,
// which a slot only joins after its productionRecords write AND session
// sync succeed, and which a reopened session rebuilds from the slot's
// actual records (utils/productionDraft fillFromRecords). Typing into a
// slot never makes it "saved". Each hourly slot is passed its own flags,
// so saving one slot never changes another slot's button.

export type SlotSaveButtonVariant = 'save' | 'update' | 'disabled';

export interface SlotSaveButtonState {
  label: string;
  variant: SlotSaveButtonVariant;
  // Blocks the press: the line is stopped, or this slot's save is in flight.
  disabled: boolean;
}

export function slotSaveButtonState(opts: { saved: boolean; saving: boolean; lineStopped: boolean }): SlotSaveButtonState {
  const { saved, saving, lineStopped } = opts;
  // While a save runs the button keeps its previous colour, so a failed
  // save leaves it exactly as it was before the tap.
  const label = saving ? (saved ? 'Updating…' : 'Saving…') : (saved ? 'Update Slot' : 'Save Slot');
  return {
    label,
    variant: lineStopped ? 'disabled' : saved ? 'update' : 'save',
    disabled: lineStopped || saving,
  };
}
