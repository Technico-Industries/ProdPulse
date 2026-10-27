// scripts/testProdAIPanel.ts
//
// Checks for the Prod AI popup's non-visual behaviour:
//   • the conversation store (src/utils/prodAIConversation.ts) — sending,
//     replies, provider errors, retry, one request at a time, closing and
//     reopening the popup mid-request, new conversation, user switch;
//   • the thinking dots' keyframes (src/utils/prodAIThinking.ts);
//   • the popup's position per viewport (src/utils/prodAIPanelLayout.ts).
// The backend is a fake ask function. Plain node:assert script:
//   npm run test:prod-ai-panel

import assert from 'node:assert/strict';
import { createProdAIConversation, historyFor, AskFn } from '../src/utils/prodAIConversation';
import { AI_LIMITS, ProdPulseAIResponse } from '../src/utils/prodPulseAI';
import {
  THINKING_DOT_COUNT,
  THINKING_PEAK_OPACITY,
  THINKING_REST_OPACITY,
  THINKING_STATIC_OPACITY,
  thinkingDotInputRange,
  thinkingDotLevel,
  thinkingDotOpacityRange,
  thinkingDotRiseRange,
} from '../src/utils/prodAIThinking';
import { prodAIPanelFrame, PROD_AI_PANEL_WIDTH } from '../src/utils/prodAIPanelLayout';

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}`);
    throw e;
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0));

// A backend whose answers the test releases by hand.
function fakeBackend() {
  const calls: { question: string; history: { role: string; text: string }[]; resolve: (r: ProdPulseAIResponse) => void; reject: (e: unknown) => void }[] = [];
  const ask: AskFn = (question, history) =>
    new Promise((resolve, reject) => { calls.push({ question, history, resolve, reject }); });
  return { ask, calls };
}
const reply = (text: string): ProdPulseAIResponse =>
  ({ reply: `  ${text}  `, results: [], toolErrors: [], dataRetrieved: false, generatedAt: '2026-10-27T10:00:00Z' } as unknown as ProdPulseAIResponse);
const providerError = (retryable: boolean) =>
  ({ message: 'Prod AI took too long to answer. Please try again.', retryable, category: 'TIMEOUT', reason: 'DEADLINE' });

async function main() {
  console.log('Prod AI popup');

  await test('send → thinking → reply; the composer draft clears', async () => {
    const b = fakeBackend();
    const c = createProdAIConversation(b.ask);
    c.getState().setDraft('  What is today\'s total production?  ');
    assert.equal(c.getState().send(c.getState().draft), true);
    assert.equal(c.getState().draft, '');
    assert.equal(c.getState().isSending, true); // the one thinking indicator shows
    assert.equal(b.calls.length, 1);
    assert.equal(b.calls[0].question, "What is today's total production?");
    assert.deepEqual(c.getState().messages.map((m) => m.role), ['user']);
    b.calls[0].resolve(reply('Total is 1,240.'));
    await flush();
    assert.equal(c.getState().isSending, false);
    const last = c.getState().messages.at(-1)!;
    assert.equal(last.role, 'assistant');
    assert.equal(last.text, 'Total is 1,240.');
  });

  await test('one request at a time: sends while thinking are ignored; empty input never sends', async () => {
    const b = fakeBackend();
    const c = createProdAIConversation(b.ask);
    assert.equal(c.getState().send('   '), false);
    c.getState().send('first');
    assert.equal(c.getState().send('second'), false);
    assert.equal(c.getState().send('third'), false);
    assert.equal(b.calls.length, 1);
    assert.equal(c.getState().messages.length, 1);
  });

  await test('closing and reopening the popup (repeatedly, mid-request) sends nothing and keeps the conversation', async () => {
    const b = fakeBackend();
    const c = createProdAIConversation(b.ask);
    c.getState().ensureOwner('admin-1');
    c.getState().send('Which lines are below target today?');
    // Popup closes and reopens many times: each mount runs ensureOwner for
    // the same user and reads the store — no request, no reset.
    for (let i = 0; i < 10; i++) c.getState().ensureOwner('admin-1');
    assert.equal(b.calls.length, 1);
    assert.equal(c.getState().isSending, true);
    // Reply arrives while closed; it is there when reopened.
    b.calls[0].resolve(reply('L3 and L7.'));
    await flush();
    assert.deepEqual(c.getState().messages.map((m) => m.text), ['Which lines are below target today?', 'L3 and L7.']);
    // An unsent draft survives a close too.
    c.getState().setDraft('and yester');
    c.getState().ensureOwner('admin-1');
    assert.equal(c.getState().draft, 'and yester');
    // Next question carries the earlier turns as context.
    c.getState().send('and yesterday?');
    assert.deepEqual(b.calls[1].history, [
      { role: 'user', text: 'Which lines are below target today?' },
      { role: 'model', text: 'L3 and L7.' },
    ]);
  });

  await test('provider error → error bubble with Retry → retry succeeds, context unchanged', async () => {
    const b = fakeBackend();
    const c = createProdAIConversation(b.ask);
    c.getState().send('q1');
    b.calls[0].resolve(reply('a1'));
    await flush();
    c.getState().send('q2');
    b.calls[1].reject(providerError(true));
    await flush();
    const failed = c.getState().messages.at(-1)!;
    assert.equal(failed.error?.category, 'TIMEOUT');
    assert.equal(failed.error?.reason, 'DEADLINE');
    assert.equal(failed.error?.question, 'q2');
    assert.equal(c.getState().isSending, false);
    assert.equal(c.getState().retry(failed.id), true);
    assert.equal(c.getState().retry(failed.id), false); // double tap
    assert.equal(b.calls.length, 3);
    assert.equal(b.calls[2].question, 'q2');
    assert.deepEqual(b.calls[2].history, [{ role: 'user', text: 'q1' }, { role: 'model', text: 'a1' }]);
    b.calls[2].resolve(reply('a2'));
    await flush();
    assert.deepEqual(c.getState().messages.map((m) => m.text), ['q1', 'a1', 'q2', 'a2']);
  });

  await test('non-retryable and unexpected errors', async () => {
    const b = fakeBackend();
    const c = createProdAIConversation(b.ask);
    c.getState().send('q');
    b.calls[0].reject(providerError(false));
    await flush();
    const m = c.getState().messages.at(-1)!;
    assert.equal(m.error?.retryable, false);
    assert.equal(c.getState().retry(m.id), false);
    // Something that isn't a classified error → generic retryable message.
    c.getState().send('q again');
    b.calls[1].reject(new Error('boom'));
    await flush();
    const g = c.getState().messages.at(-1)!;
    assert.equal(g.error?.category, 'INVALID_RESPONSE');
    assert.equal(g.error?.retryable, true);
  });

  await test('new conversation drops a reply still in flight; a different user starts clean', async () => {
    const b = fakeBackend();
    const c = createProdAIConversation(b.ask);
    c.getState().ensureOwner('admin-1');
    c.getState().send('old question');
    c.getState().newConversation();
    assert.equal(c.getState().isSending, false);
    b.calls[0].resolve(reply('late answer'));
    await flush();
    assert.deepEqual(c.getState().messages, []);
    // Another admin signs in on the same device.
    c.getState().send('mine');
    c.getState().setDraft('draft');
    c.getState().ensureOwner('admin-2');
    assert.deepEqual(c.getState().messages, []);
    assert.equal(c.getState().draft, '');
    b.calls[1].resolve(reply('not for admin-2'));
    await flush();
    assert.deepEqual(c.getState().messages, []);
  });

  await test('history sent as context stays within the backend limits', () => {
    const long = 'x'.repeat(AI_LIMITS.maxHistoryMessageChars + 50);
    const msgs = Array.from({ length: AI_LIMITS.maxHistoryMessages + 6 }, (_, i) => ({
      id: String(i), role: (i % 2 ? 'assistant' : 'user') as 'user' | 'assistant', text: i === 0 ? long : `m${i}`,
    }));
    const h = historyFor(msgs);
    assert.ok(h.length <= AI_LIMITS.maxHistoryMessages);
    assert.equal(h[0].role, 'user');
    assert.ok(h.every((t) => t.text.length <= AI_LIMITS.maxHistoryMessageChars));
    assert.ok(h.reduce((s, t) => s + t.text.length, 0) <= AI_LIMITS.maxHistoryTotalChars);
  });

  await test('thinking dots: valid keyframes, pulse left to right, one peak each', () => {
    for (let i = 0; i < THINKING_DOT_COUNT; i++) {
      const xs = thinkingDotInputRange(i);
      assert.equal(xs.length, thinkingDotOpacityRange().length);
      assert.equal(xs.length, thinkingDotRiseRange().length);
      assert.equal(xs[0], 0);
      assert.equal(xs[xs.length - 1], 1);
      for (let k = 1; k < xs.length; k++) assert.ok(xs[k] > xs[k - 1], `dot ${i} input range increases`);
    }
    // Each dot's brightest moment comes after the previous dot's.
    const peakAt = (i: number) => {
      let best = 0, at = 0;
      for (let t = 0; t <= 1000; t++) {
        const v = thinkingDotLevel(i, t / 1000);
        if (v > best) { best = v; at = t / 1000; }
      }
      return { best, at };
    };
    const peaks = [0, 1, 2].map(peakAt);
    peaks.forEach((p) => assert.ok(Math.abs(p.best - THINKING_PEAK_OPACITY) < 1e-9));
    assert.ok(peaks[0].at < peaks[1].at && peaks[1].at < peaks[2].at);
    // At rest at the start and end of the cycle — the loop has no jump.
    for (let i = 0; i < 3; i++) {
      assert.equal(thinkingDotLevel(i, 0), THINKING_REST_OPACITY);
      assert.equal(thinkingDotLevel(i, 1), THINKING_REST_OPACITY);
    }
    // Reduced motion: a steady, visible level.
    assert.ok(THINKING_STATIC_OPACITY > THINKING_REST_OPACITY && THINKING_STATIC_OPACITY <= 1);
  });

  await test('popup layout: desktop floating, mobile web fill, React Native sheet', () => {
    const noInsets = { top: 0, bottom: 0, left: 0, right: 0 };
    const desk = prodAIPanelFrame('web', { width: 1440, height: 900 }, noInsets);
    assert.equal(desk.layout, 'floating');
    assert.equal(desk.width, PROD_AI_PANEL_WIDTH);
    assert.equal(desk.right, 24);
    assert.equal(desk.bottom, 24);
    assert.equal(900 - desk.top - desk.bottom, 680); // capped height
    const shortDesk = prodAIPanelFrame('web', { width: 1024, height: 500 }, noInsets);
    assert.equal(shortDesk.top, 24); // fits with margins on a short window
    const phone = prodAIPanelFrame('web', { width: 375, height: 667 }, { top: 20, bottom: 34, left: 0, right: 0 });
    assert.equal(phone.layout, 'fill');
    assert.deepEqual([phone.left, phone.right, phone.top, phone.bottom], [8, 8, 28, 42]);
    const app = prodAIPanelFrame('android', { width: 360, height: 780 }, { top: 24, bottom: 16, left: 0, right: 0 });
    assert.equal(app.layout, 'sheet');
    assert.deepEqual([app.left, app.right, app.top, app.bottom], [0, 0, 24, 16]);
  });

  console.log(`\n${passed} passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
