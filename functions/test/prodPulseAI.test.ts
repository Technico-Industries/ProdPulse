// functions/test/prodPulseAI.test.ts
//
// Checks for ProdPulse AI: the web-only gate, the backend's auth / admin /
// validation / rate-limit path, the read-only tools against the app's own
// report calculations, the Gemini loop's error handling, and the export.
// Plain node:assert script, like the project's other checks:  npm run test:ai
//
// Firestore and Gemini are mocked: an in-memory data source that selects
// productionRecords with the real utils/productionDay logic, a scripted
// generate() function, and — for the real @google/genai SDK wiring — a fake
// fetch that records what would be sent to generativelanguage.googleapis.com.
// No live API is called.

import '../src/timezone'; // plant timezone first — exactly as the deployed function does
import assert from 'node:assert/strict';
import { HttpsError } from 'firebase-functions/v2/https';
import { applyProductionTimezone, DEFAULT_PRODUCTION_TIMEZONE } from '../src/timezone';
import { createRateLimiter, handleProdPulseAI, HandlerDeps, providerDetail, toHttpsError } from '../src/handler';
import { readFileSync } from 'node:fs';
import { runAssistant, GenerateFn, GenResponse, MAX_TOOL_ROUNDS } from '../src/assistant';
import { AIConfigError, createGeminiGenerateFn, DEFAULT_GEMINI_MODEL, GEMINI_BASE_URL, geminiEndpoint, isPlausibleModelId } from '../src/gemini';
import { googleErrorInfo } from '../src/handler';
import {
  applyFilters,
  createToolContext,
  executeTool,
  mapAIRecord,
  productionTotals,
  TOOL_DECLARATIONS,
  TOOL_NAMES,
  ToolArgError,
} from '../src/tools';
import { COLLECTIONS, firestoreDataSource, ProductionDataSource, RawDoc } from '../src/dataSource';
import { legacyCreatedAtWindow, selectRecordsInProductionRange, timestampToMillis, productionDayKeyFor } from '../../src/utils/productionDay';
import { productionRecordId } from '../../src/utils/productionDraft';
import { buildReport, EMPTY_FILTERS, mapProductionRecord } from '../../src/utils/modelPartProduction';
import { efficiencyOf } from '../../src/utils/lineEfficiency';
import { ADMIN_MENU_ITEMS, visibleMenuItems } from '../../src/constants/adminMenu';
import { buildResultExportTables, canOpenProdAI, classifyCallableError, isStatusZeroError, isProdPulseAIAvailable, validateAIRequest, AI_LIMITS, ResultBlock } from '../../src/utils/prodPulseAI';

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(e);
  }
}

// ─── Fixture ─────────────────────────────────────────────────────────────────

const ist = (y: number, mo: number, d: number, h: number, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
// "Now": 23 Oct 2026, 10:00 plant time → production date 2026-10-23.
const NOW = ist(2026, 10, 23, 10, 0);

const LINES: RawDoc[] = [
  {
    id: 'L1',
    data: { lineName: 'JAC-03', plant: 'Bawal 1', workshop: 'Assembly Shop', division: 'Side Door', parts: [{ name: 'Door Hinge LH', cycleTimeSeconds: 30 }, { name: 'Door Hinge RH', cycleTimeSeconds: 30 }] },
  },
  { id: 'L2', data: { lineName: 'JAC-04', plant: 'Bawal 2', workshop: 'Welding Shop', division: null, parts: [{ name: 'Hood Hinge', cycleTimeSeconds: 40 }] } },
];

function rec(o: {
  id?: string; date: string | null; line: 'L1' | 'L2'; shift: 'A' | 'B'; slot: number; seg?: 'full' | 'before' | 'after';
  part: string; produced: number; expected: number; rejections: number | null; createdAt: number; updatedAt?: number;
  stops?: { stopId: string; reason: string; durationMinutes: number }[];
}): RawDoc {
  const seg = o.seg ?? 'full';
  const id = o.id ?? productionRecordId({ productionDate: o.date ?? '', lineId: o.line, shift: o.shift, slotIndex: o.slot, segment: seg });
  return {
    id,
    data: {
      ...(o.date ? { productionDate: o.date } : {}),
      lineId: o.line, lineName: o.line === 'L1' ? 'JAC-03' : 'JAC-04', shift: o.shift, slotIndex: o.slot,
      ...(seg !== 'full' ? { partSegment: seg } : {}),
      partName: o.part, producedThisSlot: o.produced, expectedParts: o.expected,
      ...(o.rejections != null ? { rejections: o.rejections } : {}),
      stopEvents: o.stops ?? [],
      supervisor: { uid: 'sup-1', name: 'Ramesh Kumar' },
      operators: [{ name: 'Operator Secret', code: 'E-77' }],
      createdAt: o.createdAt, updatedAt: o.updatedAt ?? o.createdAt,
    },
  };
}

const RECORDS: RawDoc[] = [
  rec({ date: '2026-10-21', line: 'L1', shift: 'A', slot: 0, part: 'Door Hinge LH', produced: 100, expected: 110, rejections: 5, createdAt: ist(2026, 10, 21, 8), stops: [{ stopId: 'stop-1', reason: 'maintenance', durationMinutes: 10 }] }),
  rec({ date: '2026-10-21', line: 'L1', shift: 'A', slot: 1, seg: 'before', part: 'Door Hinge LH', produced: 40, expected: 50, rejections: 2, createdAt: ist(2026, 10, 21, 9) }),
  rec({ date: '2026-10-21', line: 'L1', shift: 'A', slot: 1, seg: 'after', part: 'Door Hinge RH', produced: 30, expected: 30, rejections: 0, createdAt: ist(2026, 10, 21, 9) }),
  // Legacy addDoc duplicate of slot 0 — excluded, but reported.
  rec({ id: 'legacy-dup', date: '2026-10-21', line: 'L1', shift: 'A', slot: 0, part: 'Door Hinge LH', produced: 100, expected: 110, rejections: 5, createdAt: ist(2026, 10, 21, 8, 5) }),
  // Shift B, saved at 2:00 AM on the 22nd but filed under the 21st.
  rec({ date: '2026-10-21', line: 'L2', shift: 'B', slot: 7, part: 'Hood Hinge', produced: 80, expected: 90, rejections: null, createdAt: ist(2026, 10, 22, 2), stops: [{ stopId: 'stop-9', reason: 'material shortage', durationMinutes: 5 }] }),
  // Legacy Shift B record with no productionDate, saved 1:30 AM on the 22nd → belongs to the 21st.
  rec({ id: 'legacy-b', date: null, line: 'L2', shift: 'B', slot: 6, part: 'Hood Hinge', produced: 20, expected: 20, rejections: 1, createdAt: ist(2026, 10, 22, 1, 30) }),
  rec({ date: '2026-10-22', line: 'L1', shift: 'A', slot: 0, part: 'Door Hinge LH', produced: 50, expected: 60, rejections: 0, createdAt: ist(2026, 10, 22, 8) }),
];

const SESSIONS: RawDoc[] = [
  {
    id: 'L1',
    data: {
      lineId: 'L1', productionDate: '2026-10-23', shift: 'A', lineStopped: true,
      stopsBySlot: { 2: [{ id: `stop-${NOW - 30 * 60000}`, reason: 'quality', startAbs: NOW - 30 * 60000, running: true }] },
    },
  },
];

const REJECTION_LOG: RawDoc[] = [
  { id: 'j1', data: { date: '2026-10-21', shift: 'A', lineId: 'L1', partName: 'Door Hinge LH', stage: 'Final', defect: 'Burr', rejectionQty: 4 } },
  { id: 'j2', data: { date: '2026-10-21', shift: 'B', lineId: 'L2', partName: 'Hood Hinge', stage: 'In-process', defect: 'Dent', rejectionQty: 6 } },
  { id: 'j3', data: { date: '2026-10-22', shift: 'A', lineId: 'L1', partName: 'Door Hinge LH', stage: 'Final', defect: 'Burr', rejectionQty: 1 } },
];

const PROFILES: Record<string, Record<string, any> | null> = {
  admin: { role: 'admin', active: true },
  inactiveAdmin: { role: 'admin', active: false },
  supervisor: { role: 'supervisor', active: true },
};

function memorySource(overrides: Partial<ProductionDataSource> = {}): ProductionDataSource & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    async getUserProfile(uid) { reads.push('users'); return PROFILES[uid] ?? null; },
    async getProductionRecords(from, to) {
      reads.push('productionRecords');
      const { startMs, endMs } = legacyCreatedAtWindow(from, to);
      const row = (d: RawDoc) => ({ id: d.id, shift: d.data.shift, productionDate: d.data.productionDate, createdAtMs: timestampToMillis(d.data.createdAt), doc: d });
      const byDate = RECORDS.filter((d) => typeof d.data.productionDate === 'string' && d.data.productionDate >= from && d.data.productionDate <= to).map(row);
      const byCreated = RECORDS.filter((d) => d.data.createdAt >= startMs && d.data.createdAt < endMs).map(row);
      return selectRecordsInProductionRange([byDate, byCreated], from, to);
    },
    async getProductionLines() { reads.push('productionLines'); return LINES; },
    async getActiveSessions() { reads.push('activeSessions'); return SESSIONS; },
    async getRejectionLog(from, to) { reads.push('rejectionRecords'); return REJECTION_LOG.filter((d) => d.data.date >= from && d.data.date <= to); },
    ...overrides,
  };
}

const ctx = (data: ProductionDataSource = memorySource()) => createToolContext(data, NOW);

// Scripted Gemini: each call returns the next response.
function scripted(responses: (GenResponse | Error | 'hang')[]) {
  const calls: { contents: unknown[]; config: Record<string, any> }[] = [];
  const fn: GenerateFn = async (params) => {
    calls.push({ contents: JSON.parse(JSON.stringify(params.contents)), config: params.config });
    const r = responses[Math.min(calls.length - 1, responses.length - 1)];
    if (r === 'hang') return new Promise<GenResponse>(() => {});
    if (r instanceof Error) throw r;
    return r;
  };
  return { fn, calls };
}

// Gemini generateContent output: the function call part carries a thought
// signature that must be sent back unchanged.
const toolCall = (name: string, args: Record<string, unknown>, id = 'c1'): GenResponse => ({
  functionCalls: [{ id, name, args }],
  candidates: [{ content: { role: 'model', parts: [{ functionCall: { id, name, args }, thoughtSignature: 'sig' }] } }],
  usageMetadata: { totalTokenCount: 500 },
});
const answer = (text: string): GenResponse => ({ text, candidates: [{ content: { role: 'model', parts: [{ text }] } }], usageMetadata: { totalTokenCount: 300 } });

// What the @google/genai SDK throws: ApiError with the HTTP status and
// Google's JSON error body in the message.
function apiError(status: number, message = 'provider detail that must not leak', googleStatus = 'UNKNOWN', reason?: string) {
  const body = { error: { code: status, message, status: googleStatus, ...(reason ? { details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason, domain: 'googleapis.com' }] } : {}) } };
  return Object.assign(new Error(`got status: ${status} . ${JSON.stringify(body)}`), { status });
}

function deps(over: Partial<HandlerDeps> & { gen?: GenerateFn } = {}): HandlerDeps & { clientBuilt: () => number } {
  let built = 0;
  const gen = over.gen ?? scripted([answer('Hello')]).fn;
  return {
    data: memorySource(),
    generate: () => { built++; return gen; },
    model: 'test-model',
    rateLimit: createRateLimiter(),
    now: () => NOW,
    ...over,
    clientBuilt: () => built,
  };
}

async function rejects(p: Promise<unknown>, code: string, category?: string) {
  await assert.rejects(p, (e: unknown) => e instanceof HttpsError && e.code === code && (!category || (e.details as any)?.category === category));
}

async function main() {
  console.log('ProdPulse AI');

  // ── 1. Web only ─────────────────────────────────────────────────────────────
  await test('1. available on web, hidden on Android / iOS (screen gate + floating button); not in the burger menu', () => {
    assert.equal(isProdPulseAIAvailable('web'), true);
    assert.equal(isProdPulseAIAvailable('android'), false);
    assert.equal(isProdPulseAIAvailable('ios'), false);
    // The burger menu no longer has a Prod AI entry on any platform.
    const routes = (os: string) => visibleMenuItems(ADMIN_MENU_ITEMS, os).map((i) => i.route);
    for (const os of ['web', 'android', 'ios']) assert.ok(!routes(os).includes('AIAssistant'), os);
    assert.ok(!ADMIN_MENU_ITEMS.some((i) => /ai/i.test(i.key) || /Prod(Pulse)? AI/.test(i.title)));
    // Every other entry is unaffected.
    assert.equal(routes('android').length, ADMIN_MENU_ITEMS.length);
    // Floating button: admins only, and only where the assistant runs.
    assert.equal(canOpenProdAI('admin', 'web'), true);
    assert.equal(canOpenProdAI('supervisor', 'web'), false);
    assert.equal(canOpenProdAI(null, 'web'), false);
    assert.equal(canOpenProdAI(undefined, 'web'), false);
    assert.equal(canOpenProdAI('admin', 'android'), false);
    assert.equal(canOpenProdAI('admin', 'ios'), false);
  });

  // ── 2–5. Auth, admin, validation ────────────────────────────────────────────
  await test('2. unauthenticated requests are rejected before any read or AI call', async () => {
    const d = deps();
    await rejects(handleProdPulseAI({ auth: null, data: { question: 'hi' } }, d), 'unauthenticated', 'AUTH_REQUIRED');
    assert.equal(d.clientBuilt(), 0);
    assert.deepEqual((d.data as any).reads, []);
  });

  await test('3. non-admin, deactivated admin and profile-less users are rejected by the backend', async () => {
    for (const uid of ['supervisor', 'inactiveAdmin', 'nobody']) {
      const d = deps();
      await rejects(handleProdPulseAI({ auth: { uid }, data: { question: 'today?' } }, d), 'permission-denied', 'ADMIN_FORBIDDEN');
      assert.equal(d.clientBuilt(), 0);
      assert.deepEqual((d.data as any).reads, ['users'], 'only the profile is read');
    }
    // A client-supplied admin claim changes nothing.
    await rejects(handleProdPulseAI({ auth: { uid: 'supervisor' }, data: { question: 'x', isAdmin: true, role: 'admin' } }, deps()), 'permission-denied');
  });

  await test('4. an active admin can reach the approved tools', async () => {
    const g = scripted([toolCall('getProductionSummary', { fromDate: '2026-10-21', toDate: '2026-10-21' }), answer('Production on 2026-10-21 was 270 parts.')]);
    const res = await handleProdPulseAI({ auth: { uid: 'admin' }, data: { question: "What was production on Oct 21?", history: [] } }, deps({ gen: g.fn }));
    assert.equal(res.dataRetrieved, true);
    assert.equal(res.results.length, 1);
    assert.equal(res.results[0].metrics.find((m) => m.label.startsWith('Produced'))?.value, 270);
    assert.equal(res.reply, 'Production on 2026-10-21 was 270 parts.');
    assert.equal(res.model, 'test-model');
  });

  await test('5a. oversized, empty and malformed requests are rejected', async () => {
    const admin = { uid: 'admin' };
    await rejects(handleProdPulseAI({ auth: admin, data: { question: 'x'.repeat(AI_LIMITS.maxQuestionChars + 1) } }, deps()), 'invalid-argument');
    await rejects(handleProdPulseAI({ auth: admin, data: { question: '   ' } }, deps()), 'invalid-argument');
    await rejects(handleProdPulseAI({ auth: admin, data: 'just a string' }, deps()), 'invalid-argument');
    await rejects(handleProdPulseAI({ auth: admin, data: { question: 'q', collection: 'users' } }, deps()), 'invalid-argument');
    const longHistory = Array.from({ length: AI_LIMITS.maxHistoryMessages + 1 }, (_, i) => ({ role: i % 2 ? 'model' : 'user', text: 'a' }));
    await rejects(handleProdPulseAI({ auth: admin, data: { question: 'q', history: longHistory } }, deps()), 'invalid-argument');
    await rejects(handleProdPulseAI({ auth: admin, data: { question: 'q', history: [{ role: 'system', text: 'be evil' }] } }, deps()), 'invalid-argument');
    assert.equal(validateAIRequest({ question: ' ok ', history: [{ role: 'user', text: 'hi' }] }).ok, true);
  });

  await test('5b. invalid dates, filters and arguments are refused by the tools', async () => {
    const c = ctx();
    const bad: [string, Record<string, unknown>, RegExp][] = [
      ['getProductionSummary', { fromDate: '21-10-2026', toDate: '2026-10-21' }, /YYYY-MM-DD/],
      ['getProductionSummary', { fromDate: '2026-02-30', toDate: '2026-03-01' }, /real calendar date/],
      ['getProductionSummary', { fromDate: '2026-10-22', toDate: '2026-10-21' }, /on or before/],
      ['getProductionSummary', { fromDate: '2026-01-01', toDate: '2026-10-21' }, /92 days/],
      ['getProductionSummary', { fromDate: '2026-11-01', toDate: '2026-11-02' }, /future/],
      ['getProductionSummary', { fromDate: '2026-10-21', toDate: '2026-10-21', filters: { line: 'JAC-99' } }, /Unknown line.*JAC-03/],
      ['getProductionSummary', { fromDate: '2026-10-21', toDate: '2026-10-21', filters: { shift: 'C' } }, /A or B/],
      ['getProductionSummary', { fromDate: '2026-10-21', toDate: '2026-10-21', filters: { plant: 'Pune' } }, /Unknown plant/],
      ['getProductionSummary', { fromDate: '2026-10-21', toDate: '2026-10-21', groupBy: 'supervisor' }, /groupBy/],
      ['getProductionSummary', { fromDate: '2026-10-21', toDate: '2026-10-21', limit: 0 }, /limit/],
      ['getProductionRecordDetails', { fromDate: '2026-10-21', toDate: '2026-10-21', limit: 5000 }, /limit/],
      ['getProductionSummary', { fromDate: '2026-10-21', toDate: '2026-10-21', filters: { collection: 'users' } }, /Unknown argument/],
      ['getProductionSummary', { fromDate: '2026-10-21', toDate: '2026-10-21', where: 'x' }, /Unknown argument/],
    ];
    for (const [name, args, re] of bad) {
      await assert.rejects(executeTool(name, args, c), (e: unknown) => e instanceof ToolArgError && re.test(e.message), `${name} ${JSON.stringify(args)}`);
    }
  });

  // ── 6. xAI failures ─────────────────────────────────────────────────────────
  await test('6a. Gemini key / billing / model / quota / outage errors map to safe callable errors', async () => {
    const cases: [Error, string, string, string, RegExp][] = [
      [apiError(429, 'Resource has been exhausted (e.g. check quota).', 'RESOURCE_EXHAUSTED'), 'resource-exhausted', 'AI_API_ERROR', 'RATE_LIMITED', /quota/],
      [apiError(400, 'API key not valid. Please pass a valid API key.', 'INVALID_ARGUMENT', 'API_KEY_INVALID'), 'failed-precondition', 'AI_CONFIGURATION_ERROR', 'KEY_INVALID', /GEMINI_API_KEY/],
      [apiError(403, 'Your billing account has an outstanding balance.', 'PERMISSION_DENIED'), 'failed-precondition', 'AI_CONFIGURATION_ERROR', 'NO_CREDITS', /billing/],
      [apiError(403, 'Requests to this API are blocked.', 'PERMISSION_DENIED', 'API_KEY_SERVICE_BLOCKED'), 'failed-precondition', 'AI_CONFIGURATION_ERROR', 'ACCESS_DENIED', /not allowed/],
      [apiError(404, 'models/gemini-9 is not found for API version v1beta, or is not supported for generateContent.', 'NOT_FOUND'), 'failed-precondition', 'AI_CONFIGURATION_ERROR', 'MODEL_UNAVAILABLE', /GEMINI_MODEL/],
      [apiError(400, 'Invalid JSON payload received.', 'INVALID_ARGUMENT'), 'internal', 'AI_API_ERROR', 'BAD_REQUEST', /rejected the request/],
      [apiError(503, 'The model is overloaded.', 'UNAVAILABLE'), 'unavailable', 'AI_API_ERROR', 'PROVIDER_UNAVAILABLE', /temporarily unavailable/],
      // The live failure: the model did not finish before X-Server-Timeout.
      [apiError(504, 'Deadline expired before operation could complete.', 'DEADLINE_EXCEEDED'), 'deadline-exceeded', 'TIMEOUT', 'TIMEOUT', /did not finish answering in time/],
      [apiError(429, 'Resource has been exhausted (e.g. check quota).', 'RESOURCE_EXHAUSTED'), 'resource-exhausted', 'AI_API_ERROR', 'RATE_LIMITED', /quota/],
      [new Error('fetch failed'), 'unavailable', 'AI_API_ERROR', 'NETWORK', /Could not reach/],
      [Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }), 'deadline-exceeded', 'TIMEOUT', 'TIMEOUT', /too long/],
    ];
    for (const [err, code, category, reason, msg] of cases) {
      await assert.rejects(
        handleProdPulseAI({ auth: { uid: 'admin' }, data: { question: 'today?' } }, deps({ gen: scripted([err]).fn })),
        (e: unknown) => e instanceof HttpsError && e.code === code && (e.details as any)?.category === category && (e.details as any)?.reason === reason && msg.test(e.message) && !/provider detail|API key not valid|outstanding balance|overloaded/.test(e.message),
        `${err.message}`
      );
    }
  });

  await test('6a2. a missing GEMINI_API_KEY is a configuration error, raised only after auth passes', async () => {
    assert.throws(() => createGeminiGenerateFn(''), AIConfigError);
    assert.throws(() => createGeminiGenerateFn(undefined), AIConfigError);
    const noKey = deps({ generate: () => createGeminiGenerateFn('  ') });
    await rejects(handleProdPulseAI({ auth: { uid: 'admin' }, data: { question: 'q' } }, noKey), 'failed-precondition', 'AI_CONFIGURATION_ERROR');
    await rejects(handleProdPulseAI({ auth: { uid: 'supervisor' }, data: { question: 'q' } }, deps({ generate: () => createGeminiGenerateFn('') })), 'permission-denied', 'ADMIN_FORBIDDEN');
  });

  await test('6b. a hung Gemini call times out', async () => {
    await assert.rejects(
      runAssistant({ question: 'q', history: [], model: 'm', generate: scripted(['hang']).fn, data: memorySource(), nowMs: NOW, callTimeoutMs: 50 }),
      (e: any) => e?.kind === 'timeout'
    );
  });

  await test('6c. empty or malformed Gemini responses are errors, not blank answers', async () => {
    const run = (r: any) => handleProdPulseAI({ auth: { uid: 'admin' }, data: { question: 'q' } }, deps({ gen: scripted([r]).fn }));
    await rejects(run({ text: '' }), 'internal', 'INVALID_RESPONSE');
    await rejects(run({}), 'internal', 'INVALID_RESPONSE');
    await rejects(run({ functionCalls: [{ name: 'getProductionSummary', args: {} }] }), 'internal', 'INVALID_RESPONSE');
  });

  await test('6c2. invalid tool arguments go back to the model as an invalid call; the loop continues', async () => {
    const g = scripted([toolCall('getProductionSummary', { fromDate: '21-10-2026', toDate: '2026-10-21' }), answer('Please give the date as YYYY-MM-DD.')]);
    const res = await runAssistant({ question: 'q', history: [], model: 'm', generate: g.fn, data: memorySource(), nowMs: NOW });
    assert.equal(res.reply, 'Please give the date as YYYY-MM-DD.');
    assert.equal(res.dataRetrieved, false);
    assert.equal(res.toolErrors.length, 0, 'an invalid call is not a database failure');
    const fr = (g.calls[1].contents.at(-1) as any).parts[0].functionResponse;
    assert.equal(fr.name, 'getProductionSummary');
    assert.equal(fr.response.invalidArguments, true);
    assert.match(fr.response.error, /YYYY-MM-DD/);
  });

  await test('6d. rate limit per user', async () => {
    const limit = createRateLimiter({ max: 2, windowMs: 1000 });
    assert.equal(limit('u', 0), true);
    assert.equal(limit('u', 10), true);
    assert.equal(limit('u', 20), false);
    assert.equal(limit('other', 20), true, 'limits are per user');
    assert.equal(limit('u', 1011), true, 'window slides');
    const d = deps({ rateLimit: () => false });
    await rejects(handleProdPulseAI({ auth: { uid: 'admin' }, data: { question: 'q' } }, d), 'resource-exhausted', 'RATE_LIMITED');
    assert.equal(d.clientBuilt(), 0);
  });

  await test('6e. tool rounds are capped; the last round forces a text answer (function calling NONE)', async () => {
    const loop = scripted(Array.from({ length: MAX_TOOL_ROUNDS }, () => toolCall('getAvailableProductionFilters', {})).concat([answer('final')]));
    const res = await runAssistant({ question: 'q', history: [], model: 'm', generate: loop.fn, data: memorySource(), nowMs: NOW });
    assert.equal(res.reply, 'final');
    assert.equal(loop.calls.length, MAX_TOOL_ROUNDS + 1);
    assert.deepEqual(loop.calls.map((c) => c.config.toolConfig.functionCallingConfig.mode), [...Array(MAX_TOOL_ROUNDS).fill('AUTO'), 'NONE']);
  });

  // ── 7–10. Calculations ──────────────────────────────────────────────────────
  await test('7. totals match the app\'s report calculations (Model / Part buildReport, efficiencyOf)', async () => {
    const { block } = await executeTool('getProductionSummary', { fromDate: '2026-10-21', toDate: '2026-10-21' }, ctx());
    const m = Object.fromEntries(block!.metrics.map((x) => [x.label, x.value]));

    const raw = await memorySource().getProductionRecords('2026-10-21', '2026-10-21');
    const report = buildReport(raw.map((d) => mapProductionRecord(d.id, d.data)), EMPTY_FILTERS);
    const eff = efficiencyOf(report.records);
    assert.equal(m['Produced (good parts)'], report.summary.produced);
    assert.equal(m['Produced (good parts)'], 270);
    assert.equal(m['Target'], eff.planned);
    assert.equal(m['Efficiency'], eff.efficiency);
    assert.equal(m['Efficiency'], 90);
    assert.equal(m['Rejected'], 8);
    // counterQuality: the legacy record without a counter (80 parts) is left out.
    assert.equal(m['Rejection rate'], Math.round((8 / (190 + 8)) * 1000) / 10);
    assert.equal(m['Downtime'], 15);
    // The excluded duplicate is reported, with what Generate Report would add.
    assert.equal(block!.complete, false);
    assert.ok(block!.notes.some((n) => /1 duplicate slot record\(s\) \(100 parts\)/.test(n)));
    // Totals of the summary row = sum of the grouped rows.
    const { block: byLine } = await executeTool('getProductionSummary', { fromDate: '2026-10-21', toDate: '2026-10-21', groupBy: 'line' }, ctx());
    assert.equal(byLine!.rows.reduce((s, r) => s + (r.produced as number), 0), 270);
  });

  await test('8. Shift B after-midnight slots (stamped and legacy) stay on the date the shift started', async () => {
    assert.equal(process.env.TZ, DEFAULT_PRODUCTION_TIMEZONE);
    const { block } = await executeTool('getProductionSummary', { fromDate: '2026-10-21', toDate: '2026-10-21', groupBy: 'shift' }, ctx());
    const b = block!.rows.find((r) => r.shift === 'Shift B')!;
    assert.equal(b.produced, 100, '80 (2:00 AM, stamped) + 20 (1:30 AM, legacy) belong to the 21st');
    const { block: d22 } = await executeTool('getProductionSummary', { fromDate: '2026-10-22', toDate: '2026-10-22', groupBy: 'shift' }, ctx());
    assert.deepEqual(d22!.rows.map((r) => [r.shift, r.produced]), [['Shift A', 50]], 'nothing from the night of the 21st leaks into the 22nd');
    // "Today" on the server follows the 6:30 AM cutover in plant time.
    assert.equal(productionDayKeyFor(ist(2026, 10, 23, 6, 29)), '2026-10-22');
    assert.equal(productionDayKeyFor(ist(2026, 10, 23, 6, 30)), '2026-10-23');
    assert.equal(applyProductionTimezone({ PRODUCTION_TIMEZONE: 'Asia/Kolkata' }), 'Asia/Kolkata');
  });

  await test('9. model/part, line, shift and plant filters are applied', async () => {
    const run = async (filters: Record<string, string>) =>
      (await executeTool('getProductionSummary', { fromDate: '2026-10-21', toDate: '2026-10-21', filters }, ctx())).block!;
    const produced = (b: ResultBlock) => b.metrics.find((m) => m.label.startsWith('Produced'))!.value;
    assert.equal(produced(await run({ line: 'JAC-03' })), 170);
    assert.equal(produced(await run({ line: 'jac 04' })), 100, 'line names match case/punctuation-insensitively');
    assert.equal(produced(await run({ part: 'door hinge rh' })), 30);
    assert.equal(produced(await run({ shift: 'B' })), 100);
    assert.equal(produced(await run({ plant: 'bawal 1' })), 170);
    assert.equal(produced(await run({ line: 'JAC-03', part: 'Door Hinge LH' })), 140);
    const b = await run({ line: 'JAC-03', part: 'Door Hinge LH' });
    assert.deepEqual(b.filters, { Line: 'JAC-03', 'Model / Part': 'Door Hinge LH' });
    const grouped = (await executeTool('getProductionSummary', { fromDate: '2026-10-21', toDate: '2026-10-21', groupBy: 'line_part' }, ctx())).block!;
    assert.deepEqual(grouped.rows.map((r) => [r.line, r.part, r.produced]), [
      ['JAC-03', 'Door Hinge LH', 140],
      ['JAC-04', 'Hood Hinge', 100],
      ['JAC-03', 'Door Hinge RH', 30],
    ]);
  });

  await test('10a. rejections: slot counter for rates, defect log separate and never added', async () => {
    const { block } = await executeTool('getRejectionSummary', { fromDate: '2026-10-21', toDate: '2026-10-21', groupBy: 'line' }, ctx());
    const jac04 = block!.rows.find((r) => r.line === 'JAC-04')!;
    assert.equal(jac04.rejected, 1);
    assert.equal(jac04.rejectionPct, Math.round((1 / 21) * 1000) / 10, 'only the record with a counter counts');
    assert.ok(block!.notes.some((n) => /no rejection counter/.test(n)));
    const log = (await executeTool('getDefectLogSummary', { fromDate: '2026-10-21', toDate: '2026-10-22' }, ctx())).block!;
    assert.equal(log.dateRange!.convention, 'calendar-date');
    assert.deepEqual(log.rows.map((r) => [r.defect, r.qty]), [['Dent', 6], ['Burr', 5]]);
    assert.ok(log.notes[0].includes('do not add'));
  });

  await test('10b. downtime: saved stopEvents, plus running sessions counted once up to now', async () => {
    const saved = (await executeTool('getDowntimeSummary', { fromDate: '2026-10-21', toDate: '2026-10-21' }, ctx())).block!;
    assert.deepEqual(saved.rows.map((r) => [r.reason, r.minutes]), [['Maintenance', 10], ['Material Shortage', 5]]);
    const live = (await executeTool('getDowntimeSummary', { fromDate: '2026-10-23', toDate: '2026-10-23', groupBy: 'line' }, ctx())).block!;
    assert.deepEqual(live.rows.map((r) => [r.line, r.minutes, r.stops]), [['JAC-03', 30, 1]]);
    assert.ok(live.notes.some((n) => /still running/.test(n)));
    // Production for a range with a live session is marked incomplete.
    const today = (await executeTool('getProductionSummary', { fromDate: '2026-10-23', toDate: '2026-10-23' }, ctx())).block!;
    assert.equal(today.complete, false);
  });

  await test('10c. comparison and target variance use the same totals', async () => {
    const cmp = (await executeTool('compareProductionPeriods', { currentFrom: '2026-10-22', currentTo: '2026-10-22', previousFrom: '2026-10-21', previousTo: '2026-10-21' }, ctx())).block!;
    const produced = cmp.rows.find((r) => r.metric === 'Produced (good parts)')!;
    assert.deepEqual([produced.current, produced.previous, produced.change], [50, 270, -220]);
    const tv = (await executeTool('getProductionTargetVariance', { fromDate: '2026-10-21', toDate: '2026-10-21' }, ctx())).block!;
    assert.deepEqual(tv.rows.map((r) => [r.line, r.variance]), [['JAC-03', -20], ['JAC-04', -10]], 'largest shortfall first');
  });

  // ── 11. Allowlist / read-only ───────────────────────────────────────────────
  await test('11a. unknown tools (writes, arbitrary queries) are refused; declarations match the registry', async () => {
    for (const name of ['deleteProductionRecord', 'endProductionSession', 'runQuery', '__proto__', 'constructor']) {
      await assert.rejects(executeTool(name, {}, ctx()), ToolArgError);
    }
    assert.deepEqual(TOOL_DECLARATIONS.map((d) => d.name).sort(), [...TOOL_NAMES].sort());
    assert.ok(TOOL_NAMES.every((n) => /^get|^compare/.test(n)), 'every tool is a read');
  });

  await test('11b. the Firestore source reads only allowlisted collections and never writes', async () => {
    const touched: string[] = [];
    const forbidden = () => { throw new Error('write attempted'); };
    const query: any = {
      where: () => query, limit: () => query, orderBy: () => query,
      get: async () => ({ docs: [], exists: false, data: () => undefined }),
      set: forbidden, update: forbidden, delete: forbidden, add: forbidden,
    };
    const db: any = {
      collection: (name: string) => { touched.push(name); return { ...query, doc: () => ({ get: query.get, set: forbidden, update: forbidden, delete: forbidden }) }; },
      batch: forbidden, runTransaction: forbidden, recursiveDelete: forbidden,
    };
    const src = firestoreDataSource(db);
    await src.getUserProfile('x');
    await src.getProductionRecords('2026-10-21', '2026-10-21');
    await src.getProductionLines();
    await src.getActiveSessions();
    await src.getRejectionLog('2026-10-21', '2026-10-21');
    assert.ok(touched.every((n) => (Object.values(COLLECTIONS) as string[]).includes(n)), touched.join(','));
  });

  await test('11c. nothing employee-related is sent to the model', async () => {
    const out = await executeTool('getProductionRecordDetails', { fromDate: '2026-10-21', toDate: '2026-10-21' }, ctx());
    const text = JSON.stringify(out);
    assert.ok(!text.includes('Ramesh') && !text.includes('Operator Secret') && !text.includes('E-77'));
  });

  // ── 12. Failed queries are never presented as data ──────────────────────────
  await test('12. a failed database query reaches the model and UI as a failure, not a result', async () => {
    const data = memorySource({ getProductionRecords: async () => { throw new Error('PERMISSION_DENIED: internal detail'); } });
    const g = scripted([toolCall('getProductionSummary', { fromDate: '2026-10-21', toDate: '2026-10-21' }), answer('I could not retrieve the data.')]);
    const res = await runAssistant({ question: 'q', history: [], model: 'm', generate: g.fn, data, nowMs: NOW });
    assert.equal(res.dataRetrieved, false);
    assert.equal(res.results.length, 0);
    assert.equal(res.toolErrors.length, 1);
    assert.ok(!res.toolErrors[0].message.includes('internal detail'));
    const fr = (g.calls[1].contents.at(-1) as any).parts[0].functionResponse;
    assert.equal(fr.name, 'getProductionSummary');
    assert.equal(fr.id, 'c1');
    assert.match(fr.response.error, /failed/);
    assert.equal(fr.response.output, undefined);
    // The model's own turn (with its thought signature) is sent back unchanged.
    assert.equal((g.calls[1].contents.at(-2) as any).parts[0].thoughtSignature, 'sig');
    // The system instruction forbids presenting failures as data.
    assert.match(g.calls[0].config.systemInstruction, /Never present a failed query as a result/);
  });

  // ── 13. Export ──────────────────────────────────────────────────────────────
  await test('13. the Excel export holds exactly the deterministic result rows', async () => {
    const { block } = await executeTool('getProductionSummary', { fromDate: '2026-10-21', toDate: '2026-10-21', groupBy: 'line', filters: { shift: 'A' } }, ctx());
    const { info, table } = buildResultExportTables(block!, '2026-10-23T04:30:00.000Z');
    assert.deepEqual(table[0], block!.columns.map((c) => c.label));
    assert.deepEqual(table.slice(1), block!.rows.map((r) => block!.columns.map((c) => r[c.key] ?? '')));
    const flat = info.map((r) => r.join(' | '));
    assert.ok(flat.some((l) => l.includes('2026-10-21 to 2026-10-21 (production date)')));
    assert.ok(flat.some((l) => l === 'Shift | Shift A'));
    assert.ok(flat.some((l) => l.startsWith('Generated at | 2026-10-23T04:30')));
    assert.ok(flat.some((l) => l.startsWith('Produced = ')), 'definitions included');
  });

  // ── Error categories (request failing in the web app) ───────────────────────
  await test('E1. browser "function missing / unreachable" is BACKEND_UNAVAILABLE, not a connection error', () => {
    // What the Firebase SDK throws when the CORS preflight to an undeployed
    // function 404s: fetch fails → status 0 → FunctionsError('internal', 'internal').
    const missing = classifyCallableError({ code: 'functions/internal', message: 'internal' }, false);
    assert.equal(missing.category, 'BACKEND_UNAVAILABLE');
    assert.match(missing.message, /may not be deployed/);
    assert.equal(missing.retryable, true);
    assert.equal(classifyCallableError({ code: 'functions/internal', message: 'internal' }, true).category, 'NETWORK_ERROR');
    assert.equal(classifyCallableError({ code: 'functions/not-found', message: 'not-found' }, false).category, 'BACKEND_UNAVAILABLE');
    assert.equal(classifyCallableError({ code: 'functions/deadline-exceeded', message: 'deadline-exceeded' }, false).category, 'TIMEOUT');
    assert.equal(classifyCallableError({ code: 'functions/internal', message: 'Response is missing data field.' }, false).category, 'INVALID_RESPONSE');
    assert.equal(classifyCallableError(new TypeError('x'), false).category, 'BACKEND_UNAVAILABLE');
    // A backend error keeps its own category and safe message.
    const server = classifyCallableError({ code: 'functions/failed-precondition', message: 'Set GEMINI_API_KEY', details: { category: 'AI_CONFIGURATION_ERROR' } }, false);
    assert.deepEqual(server, { category: 'AI_CONFIGURATION_ERROR', message: 'Set GEMINI_API_KEY', retryable: false });
    // Retired Gemini categories are not trusted any more.
    assert.equal(classifyCallableError({ code: 'functions/internal', message: 'internal', details: { category: 'GEMINI_API_ERROR' } }, false).category, 'BACKEND_UNAVAILABLE');
    assert.equal(classifyCallableError({ code: 'functions/permission-denied', message: 'x', details: { category: 'ADMIN_FORBIDDEN' } }, false).retryable, false);
    // Status 0 + reachability probe: server answered (function missing) vs no connection.
    const zero = { code: 'functions/internal', message: 'internal' };
    assert.equal(isStatusZeroError(zero), true);
    assert.equal(isStatusZeroError({ code: 'functions/not-found', message: 'not-found' }), false);
    const answered = classifyCallableError(zero, false, true);
    assert.equal(answered.category, 'BACKEND_UNAVAILABLE');
    assert.match(answered.message, /not deployed/);
    const noConn = classifyCallableError(zero, false, false);
    assert.equal(noConn.category, 'NETWORK_ERROR');
    assert.equal(noConn.retryable, true);
    // The probe never overrides a real backend answer.
    assert.equal(classifyCallableError({ code: 'functions/permission-denied', message: 'x' }, false, false).category, 'ADMIN_FORBIDDEN');
    assert.equal(classifyCallableError({ code: 'functions/unauthenticated', message: 'x' }, false, true).category, 'AUTH_REQUIRED');
    // Unknown categories from a response are not trusted.
    assert.equal(classifyCallableError({ code: 'functions/internal', message: 'internal', details: { category: 'EVIL' } }, false).category, 'BACKEND_UNAVAILABLE');
  });

  await test('E2. Gemini billing block is reported as a billing problem, without provider text', () => {
    const e = toHttpsError(apiError(403, 'Your billing account has an outstanding balance. Make a payment at https://aistudio.google.com/billing to restore service.', 'PERMISSION_DENIED'));
    assert.equal(e.code, 'failed-precondition');
    assert.equal((e.details as any).category, 'AI_CONFIGURATION_ERROR');
    assert.equal((e.details as any).reason, 'NO_CREDITS');
    assert.match(e.message, /billing/);
    assert.ok(!e.message.includes('outstanding balance'), 'provider text stays server-side');
  });

  await test('E3. server log detail masks key- and token-shaped strings', () => {
    const d = providerDetail(new Error('bad key xai-AbCdEf0123456789XyZ0123456789 and grok_0123456789abcdef_0123456789abcdef and AIzaSyA1234567890123456789012345 and Bearer eyJhbGciOi'));
    assert.ok(!/xai-AbCd|grok_0123|AIzaSy|eyJhbG/.test(d), d);
  });

  await test('E4. Firestore failures inside a tool carry FIRESTORE_QUERY_ERROR and are logged server-side', async () => {
    const logs: any[] = [];
    const data = memorySource({ getProductionRecords: async () => { throw Object.assign(new Error('The query requires an index'), { code: 9 }); } });
    const g = scripted([toolCall('getProductionSummary', { fromDate: '2026-10-21', toDate: '2026-10-21' }), answer('Could not retrieve.')]);
    const res = await runAssistant({ question: 'q', history: [], model: 'm', generate: g.fn, data, nowMs: NOW, log: (msg, meta) => logs.push({ msg, ...meta }) });
    assert.equal(res.toolErrors[0].category, 'FIRESTORE_QUERY_ERROR');
    const entry = logs.find((l) => l.msg === 'tool failed');
    assert.equal(entry.level, 'error');
    assert.equal(entry.firestoreCode, 9);
    assert.match(entry.detail, /requires an index/);
  });

  await test('E5. profile read failure is FIRESTORE_QUERY_ERROR; provider failures are logged with Google status and reason', async () => {
    const d = deps({ data: memorySource({ getUserProfile: async () => { throw new Error('UNAVAILABLE'); } }) });
    await rejects(handleProdPulseAI({ auth: { uid: 'admin' }, data: { question: 'q' } }, d), 'unavailable', 'FIRESTORE_QUERY_ERROR');
    const logs: any[] = [];
    const gen = scripted([apiError(400, 'API key not valid. Please pass a valid API key.', 'INVALID_ARGUMENT', 'API_KEY_INVALID')]).fn;
    await rejects(handleProdPulseAI({ auth: { uid: 'admin' }, data: { question: 'q' } }, deps({ gen, model: 'gemini-3.8-flash', log: (msg, meta) => logs.push({ msg, ...meta }) })), 'failed-precondition', 'AI_CONFIGURATION_ERROR');
    const entry = logs.find((l) => l.msg === 'request failed');
    assert.deepEqual(
      [entry.reason, entry.providerStatus, entry.providerCode, entry.providerReason, entry.model, entry.keyConfigured, entry.endpoint],
      ['KEY_INVALID', 400, 'INVALID_ARGUMENT', 'API_KEY_INVALID', 'gemini-3.8-flash', true, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent']
    );
    assert.match(entry.detail, /API key not valid/);
    assert.deepEqual(googleErrorInfo(new Error('no json here')), { status: null, reason: null });
  });

  // ── Gemini wiring (real @google/genai SDK, fake fetch — no network) ─────────
  await test('G1. the backend calls Gemini through @google/genai with GEMINI_API_KEY; no xAI code remains', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    assert.ok(pkg.dependencies['@google/genai'], '@google/genai is a dependency');
    assert.equal(pkg.dependencies.openai, undefined, 'OpenAI SDK (used only for xAI) removed');
    for (const f of ['index.ts', 'gemini.ts', 'assistant.ts', 'handler.ts', 'tools.ts', 'dataSource.ts', 'cors.ts', 'options.ts']) {
      const src = readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');
      assert.ok(!/from 'openai'|api\.x\.ai|XAI_API_KEY|XAI_MODEL/.test(src), `${f} has no xAI references`);
    }
    const index = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
    assert.match(index, /defineSecret\('GEMINI_API_KEY'\)/);
    assert.match(index, /defineString\('GEMINI_MODEL'/);
    assert.equal(GEMINI_BASE_URL, 'https://generativelanguage.googleapis.com');
    assert.equal(DEFAULT_GEMINI_MODEL, 'gemini-3.8-flash');
  });

  await test('G2. a full question goes to Gemini generateContent with the right model, key header and tools; tool results are real query output', async () => {
    const sent: { url: string; method: string; key: string | null; auth: string | null; body: any }[] = [];
    const bodies = [
      { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'getProductionSummary', args: { fromDate: '2026-10-21', toDate: '2026-10-21' } }, thoughtSignature: 'c2ln' }] }, finishReason: 'STOP' }], usageMetadata: { totalTokenCount: 500 } },
      { candidates: [{ content: { role: 'model', parts: [{ text: 'Production on 2026-10-21 was 270 good parts.' }] }, finishReason: 'STOP' }], usageMetadata: { totalTokenCount: 300 } },
    ];
    const fakeFetch = (async (url: any, init: any) => {
      const headers = new Headers(init?.headers);
      sent.push({ url: String(url), method: init?.method, key: headers.get('x-goog-api-key'), auth: headers.get('authorization'), body: JSON.parse(init?.body) });
      return new Response(JSON.stringify(bodies[sent.length - 1]), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const generate = createGeminiGenerateFn('test-gemini-key-not-real', fakeFetch);
    const res = await handleProdPulseAI(
      { auth: { uid: 'admin' }, data: { question: 'What was production on Oct 21?', history: [{ role: 'user', text: 'hi' }, { role: 'model', text: 'Hello' }] } },
      deps({ generate: () => generate, model: DEFAULT_GEMINI_MODEL })
    );
    assert.equal(sent.length, 2);
    for (const r of sent) {
      assert.equal(r.url.split('?')[0], geminiEndpoint('gemini-3.8-flash'));
      assert.equal(r.method, 'POST');
      assert.equal(r.key, 'test-gemini-key-not-real', 'key sent in the x-goog-api-key header');
      assert.ok(!r.url.includes('test-gemini-key-not-real'), 'key not in the URL');
      assert.deepEqual(r.body.tools[0].functionDeclarations.map((d: any) => d.name).sort(), [...TOOL_NAMES].sort());
      assert.match(JSON.stringify(r.body.systemInstruction ?? r.body.system_instruction), /You are Prod AI,/);
    }
    assert.deepEqual(sent[0].body.contents.map((c: any) => c.role), ['user', 'model', 'user']);
    // Round 2 replays the model turn with its thought signature, then the real tool result.
    const replay = sent[1].body.contents;
    assert.equal(replay.at(-2).parts[0].thoughtSignature, 'c2ln');
    const fr = replay.at(-1).parts[0].functionResponse;
    assert.equal(fr.name, 'getProductionSummary');
    assert.equal(fr.response.output.metrics['Produced (good parts)'], 270);
    assert.equal(res.reply, 'Production on 2026-10-21 was 270 good parts.');
    assert.equal(res.results[0].metrics.find((m) => m.label.startsWith('Produced'))!.value, 270);
    assert.equal(res.model, 'gemini-3.8-flash');
  });

  await test('G3. a real Gemini "API key not valid" through the SDK is KEY_INVALID, logged with Google status and reason — never the key', async () => {
    const logs: any[] = [];
    const key = 'AIzaSyFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE00';
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT', details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID', domain: 'googleapis.com' }] } }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;
    const generate = createGeminiGenerateFn(key, fakeFetch);
    await assert.rejects(
      handleProdPulseAI({ auth: { uid: 'admin' }, data: { question: 'q' } }, deps({ generate: () => generate, model: DEFAULT_GEMINI_MODEL, log: (msg, meta) => logs.push({ msg, ...meta }) })),
      (e: unknown) => e instanceof HttpsError && (e.details as any).reason === 'KEY_INVALID' && !e.message.includes('not valid. Please')
    );
    const entry = logs.find((l) => l.msg === 'request failed');
    assert.equal(entry.providerStatus, 400);
    assert.equal(entry.providerCode, 'INVALID_ARGUMENT');
    assert.equal(entry.providerReason, 'API_KEY_INVALID');
    assert.ok(!JSON.stringify(logs).includes(key), 'key never logged');
  });

  await test('G4. a secret stored with a trailing CR/LF (Windows paste) is sent trimmed', async () => {
    let key: string | null = null;
    const fakeFetch = (async (_url: any, init: any) => {
      key = new Headers(init?.headers).get('x-goog-api-key');
      return new Response(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const generate = createGeminiGenerateFn('AIzaTrimMe\r\n', fakeFetch);
    await handleProdPulseAI({ auth: { uid: 'admin' }, data: { question: 'q' } }, deps({ generate: () => generate, model: DEFAULT_GEMINI_MODEL }));
    assert.equal(key, 'AIzaTrimMe');
  });

  await test('R1. each provider failure gets its own reason code; the client keeps it', () => {
    const reasonOf = (e: unknown) => (toHttpsError(e).details as any).reason;
    assert.equal(reasonOf(new AIConfigError('GEMINI_API_KEY is not set.')), 'KEY_MISSING');
    assert.equal(reasonOf(apiError(401, 'Unauthorized', 'UNAUTHENTICATED')), 'KEY_INVALID');
    assert.equal(reasonOf(apiError(400, 'API key expired. Please renew the API key.', 'INVALID_ARGUMENT', 'API_KEY_INVALID')), 'KEY_INVALID');
    assert.equal(reasonOf(apiError(403, 'Method doesn\'t allow unregistered callers.', 'PERMISSION_DENIED')), 'ACCESS_DENIED');
    assert.notEqual(toHttpsError(apiError(401, 'x')).message, toHttpsError(apiError(403, 'x')).message);
    const c = classifyCallableError({ code: 'functions/failed-precondition', message: 'm', details: { category: 'AI_CONFIGURATION_ERROR', reason: 'KEY_INVALID' } }, false);
    assert.equal(c.reason, 'KEY_INVALID');
    assert.equal(classifyCallableError({ code: 'functions/failed-precondition', message: 'm', details: { category: 'AI_CONFIGURATION_ERROR', reason: 'EVIL' } }, false).reason, undefined);
  });

  await test('R4. a key pasted into GEMINI_MODEL is refused before any Gemini call, and never logged', async () => {
    for (const m of ['gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemini-3.6-flash', 'gemini-2.5-pro']) assert.ok(isPlausibleModelId(m), m);
    const pasted = 'AQ.Ab8FAKEFAKEFAKEFAKEFAKEFAKEFAKE';
    for (const m of [pasted, 'AIzaSyFAKE', '', ' gemini-3.8-flash', 'Gemini 3', 'a'.repeat(80), undefined]) assert.ok(!isPlausibleModelId(m), String(m));
    const logs: any[] = [];
    const g = scripted([answer('should not be called')]);
    await rejects(
      handleProdPulseAI({ auth: { uid: 'admin' }, data: { question: 'q' } }, deps({ gen: g.fn, model: pasted, log: (msg, meta) => logs.push({ msg, ...meta }) })),
      'failed-precondition',
      'AI_CONFIGURATION_ERROR'
    );
    assert.equal(g.calls.length, 0, 'no request reaches Gemini');
    const entry = logs.find((l) => l.msg === 'request failed');
    assert.equal(entry.reason, 'MODEL_MISCONFIGURED');
    assert.ok(!JSON.stringify(logs).includes(pasted), 'the pasted value is not logged');
  });

  await test('R5. failure logs say whether a key is configured', async () => {
    const logs: any[] = [];
    await rejects(
      handleProdPulseAI({ auth: { uid: 'admin' }, data: { question: 'q' } }, deps({ generate: () => createGeminiGenerateFn(''), model: 'gemini-3.8-flash', log: (msg, meta) => logs.push({ msg, ...meta }) })),
      'failed-precondition'
    );
    const entry = logs.find((l) => l.msg === 'request failed');
    assert.equal(entry.keyConfigured, false);
    assert.equal(entry.reason, 'KEY_MISSING');
  });

  // Mapping sanity — legacy shapes don't break the aggregation.
  await test('mapping: missing numbers and odd stop events are tolerated', () => {
    const r = mapAIRecord({ id: 'x', data: { lineId: 'L1', shift: 'A', stopEvents: [null, { reason: '', durationMinutes: 'x' }] } });
    const t = productionTotals(applyFilters([r], { plant: null, workshop: null, division: null, lineId: null, lineName: null, partKey: null, partName: null, partRegistered: true, shift: null }));
    assert.deepEqual([t.produced, t.target, t.downtimeMinutes, t.efficiencyPct], [0, 0, 0, null]);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main();
