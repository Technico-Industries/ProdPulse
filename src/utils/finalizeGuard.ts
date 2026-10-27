// src/utils/finalizeGuard.ts
//
// One-at-a-time guard for Record Production's Finalize & End / Done
// Production (both run the same finalize). Busy from the first tap until the
// run is over — which may be after `start` has returned: when start shows a
// confirm dialog it hands the release over to the dialog's buttons (and from
// there to the finalize itself). Any tap while busy is ignored, so a double
// tap can never show two dialogs or finalize twice.

export interface FinalizeGuard {
  isBusy(): boolean;
  // Runs start unless a run is already in progress (then returns false).
  // start resolves true when it handed `release` to a later step that will
  // call it, false when it is done (the guard then releases itself). A throw
  // releases too.
  run(start: (release: () => void) => Promise<boolean>): Promise<boolean>;
}

export function createFinalizeGuard(onBusyChange: (busy: boolean) => void): FinalizeGuard {
  let runId = 0;
  let busy = false;
  const set = (b: boolean) => {
    busy = b;
    onBusyChange(b);
  };
  return {
    isBusy: () => busy,
    async run(start) {
      if (busy) return false;
      const id = ++runId;
      set(true);
      // Only this run's release can end it — a late call from an earlier
      // dialog never frees a newer run.
      const release = () => {
        if (busy && runId === id) set(false);
      };
      let handedOff = false;
      try {
        handedOff = await start(release);
      } finally {
        if (!handedOff) release();
      }
      return true;
    },
  };
}
