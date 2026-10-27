// scripts/testDoneProduction.ts
//
// Checks for Record Production's Done Production / Finalize & End guard
// (src/utils/finalizeGuard.ts): duplicate taps, cancel, success and
// failure. The guarded work below has the same shape as the screen's
// runFinalizeSession: checks + sync, then a confirm dialog whose buttons run
// (or cancel) the finalize. Plain node:assert script:
//   npm run test:done-production

import assert from 'node:assert/strict';
import { createFinalizeGuard } from '../src/utils/finalizeGuard';

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}`);
    throw e;
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0));

// A fake screen: dialog buttons are captured so the test can press them.
function harness(opts: { syncOk?: boolean; finalizeFails?: boolean } = {}) {
  const busyLog: boolean[] = [];
  const guard = createFinalizeGuard((b) => busyLog.push(b));
  const dialogs: { confirm: () => void; cancel: () => void }[] = [];
  let finalizeRuns = 0;
  let finalized = false;
  const errors: string[] = [];

  const proceedWithFinalize = async () => {
    finalizeRuns++;
    await tick();
    try {
      if (opts.finalizeFails) throw new Error('network');
      finalized = true;
    } catch (e) {
      errors.push(String(e)); // the screen alerts and keeps the session
    }
  };

  const runFinalizeSession = async (release: () => void) => {
    await tick(); // persistSession()
    if (opts.syncOk === false) return false; // "Not synced — cannot finalize yet"
    dialogs.push({
      confirm: () => { proceedWithFinalize().finally(release); },
      cancel: () => release(),
    });
    return true;
  };

  return {
    guard,
    busyLog,
    dialogs,
    errors,
    tap: () => guard.run(runFinalizeSession),
    get finalizeRuns() { return finalizeRuns; },
    get finalized() { return finalized; },
  };
}

async function main() {
  console.log('Done Production');

  await test('duplicate taps show one dialog and finalize once', async () => {
    const h = harness();
    const taps = await Promise.all([h.tap(), h.tap(), h.tap()]);
    assert.deepEqual(taps, [true, false, false]);
    assert.equal(h.dialogs.length, 1);
    assert.equal(h.guard.isBusy(), true); // still busy while the dialog is up
    assert.equal(await h.tap(), false);
    h.dialogs[0].confirm(); // the dialog closes on press
    assert.equal(await h.tap(), false); // busy while finalizing
    assert.equal(h.dialogs.length, 1);
    await tick(); await tick();
    assert.equal(h.finalizeRuns, 1);
    assert.equal(h.guard.isBusy(), false);
  });

  await test('confirm → finalize runs once, then the guard is free again', async () => {
    const h = harness();
    await h.tap();
    await h.tap();
    h.dialogs[0].confirm();
    assert.equal(h.guard.isBusy(), true);
    await tick(); await tick();
    assert.equal(h.finalizeRuns, 1);
    assert.equal(h.finalized, true);
    assert.equal(h.guard.isBusy(), false);
    assert.deepEqual(h.busyLog, [true, false]);
  });

  await test('cancel releases without finalizing', async () => {
    const h = harness();
    await h.tap();
    h.dialogs[0].cancel();
    assert.equal(h.guard.isBusy(), false);
    assert.equal(h.finalizeRuns, 0);
    // The next tap opens a new dialog.
    assert.equal(await h.tap(), true);
    assert.equal(h.dialogs.length, 2);
  });

  await test('a failed finalize is reported, nothing is marked done, and it can be retried', async () => {
    const h = harness({ finalizeFails: true });
    await h.tap();
    h.dialogs[0].confirm();
    await tick(); await tick();
    assert.equal(h.finalized, false);
    assert.deepEqual(h.errors, ['Error: network']);
    assert.equal(h.guard.isBusy(), false);
    assert.equal(await h.tap(), true);
  });

  await test('a check failing before the dialog (e.g. not synced) releases at once', async () => {
    const h = harness({ syncOk: false });
    assert.equal(await h.tap(), true);
    assert.equal(h.dialogs.length, 0);
    assert.equal(h.guard.isBusy(), false);
  });

  await test('an exception in the guarded work releases the guard', async () => {
    const guard = createFinalizeGuard(() => {});
    await assert.rejects(guard.run(async () => { throw new Error('boom'); }), /boom/);
    assert.equal(guard.isBusy(), false);
  });

  await test('a late release from an earlier dialog never frees a newer run', async () => {
    const guard = createFinalizeGuard(() => {});
    let first: () => void = () => {};
    await guard.run(async (release) => { first = release; return true; });
    first(); // first run ends
    await guard.run(async () => true); // second run, its dialog is up
    first(); // stale callback (e.g. onDismiss after a button press)
    assert.equal(guard.isBusy(), true);
  });

  console.log(`\n${passed} passed`);
}

main().catch(() => process.exit(1));
