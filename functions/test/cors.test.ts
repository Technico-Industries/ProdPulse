// functions/test/cors.test.ts
//
// HTTP-level checks of prodPulseAI's CORS: the real firebase-functions
// onCall wrapper, built with the same callableOptions() as index.ts, served
// on a local port and called the way a browser would (OPTIONS preflight,
// then POST). The handler behind it is the real handleProdPulseAI with an
// in-memory data source and a scripted model — no network beyond localhost.
//   npm run test:cors

import './corsEnv'; // test-only token-verification bypass, before firebase-functions loads
import '../src/timezone';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { onCall } from 'firebase-functions/v2/https';
import { callableOptions } from '../src/options';
import { allowedOrigins, isValidOrigin, LOCAL_DEV_ORIGINS } from '../src/cors';
import { createRateLimiter, handleProdPulseAI } from '../src/handler';
import type { GenerateFn, GenResponse } from '../src/assistant';
import type { ProductionDataSource } from '../src/dataSource';

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

const PROD_ORIGIN = 'https://prodpulse.example.com';
const ENV = { PRODPULSE_WEB_ORIGINS: `${PROD_ORIGIN}/` };

const PROFILES: Record<string, Record<string, unknown>> = {
  admin1: { role: 'admin', active: true },
  sup1: { role: 'supervisor', active: true },
};
let handlerCalls = 0;
const data: ProductionDataSource = {
  async getUserProfile(uid) { return PROFILES[uid] ?? null; },
  async getProductionRecords() { return []; },
  async getProductionLines() { return []; },
  async getActiveSessions() { return []; },
  async getRejectionLog() { return []; },
};
const reply: GenResponse = { text: 'OK from handler', candidates: [{ content: { role: 'model', parts: [{ text: 'OK from handler' }] } }] };
const generate: GenerateFn = async () => reply;

const fn = onCall(callableOptions(ENV), (request) => {
  handlerCalls++;
  return handleProdPulseAI(request, { data, generate: () => generate, model: 'gemini-test', rateLimit: createRateLimiter() });
});

// Minimal stand-in for the Cloud Functions HTTP layer: JSON body + rawBody.
const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks);
    (req as any).rawBody = raw;
    (req as any).body = raw.length ? JSON.parse(raw.toString('utf8')) : undefined;
    (req as any).header = (name: string) => req.headers[name.toLowerCase()];
    (req as any).get = (req as any).header;
    (res as any).status = (code: number) => { res.statusCode = code; return res; };
    (res as any).send = (body: unknown) => { res.end(typeof body === 'string' ? body : JSON.stringify(body)); return res; };
    (res as any).json = (body: unknown) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); return res; };
    (res as any).set = (k: string, v: string) => { res.setHeader(k, v); return res; };
    (fn as any)(req, res);
  });
});

function unsignedIdToken(uid: string) {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: uid, uid, user_id: uid, aud: 'technico-industries-ltd', iat: now, exp: now + 3600 })}.`;
}

async function main() {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/prodPulseAI`;
  const preflight = (origin: string) =>
    fetch(url, {
      method: 'OPTIONS',
      headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' },
    });
  const post = (origin: string, auth?: string, body: unknown = { data: { question: "What is today's total production?" } }) =>
    fetch(url, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
      body: JSON.stringify(body),
    });

  console.log('ProdPulse AI CORS');

  await test('allowed origins: localhost:8081 + PRODPULSE_WEB_ORIGINS, exact, no wildcard', () => {
    const warnings: string[] = [];
    assert.deepEqual(allowedOrigins(ENV), ['http://localhost:8081', PROD_ORIGIN]);
    assert.deepEqual(allowedOrigins({}, (w) => warnings.push(w)), LOCAL_DEV_ORIGINS);
    assert.match(warnings[0], /PRODPULSE_WEB_ORIGINS is not set/);
    const bad: string[] = [];
    const out = allowedOrigins({ PRODPULSE_WEB_ORIGINS: '*, https://*.vercel.app, http://evil.com, https://ok.example.com/path, https://good.example.com' }, (w) => bad.push(w));
    assert.deepEqual(out, ['http://localhost:8081', 'https://good.example.com']);
    assert.equal(bad.length, 4);
    assert.ok(out.every((o) => !o.includes('*')));
    for (const o of ['https://a.vercel.app', 'http://localhost:8081', 'https://x.example.co.in:8443']) assert.ok(isValidOrigin(o), o);
    for (const o of ['*', 'null', 'https://', 'http://a.com', 'https://a.com/', 'https://a.com/x', 'file://x']) assert.ok(!isValidOrigin(o), o);
    // index.ts passes exactly this list to onCall (not the default `true`).
    assert.deepEqual(callableOptions(ENV).cors, ['http://localhost:8081', PROD_ORIGIN]);
  });

  await test('OPTIONS preflight from http://localhost:8081 → 204 with origin, POST and the requested headers, no auth needed', async () => {
    const r = await preflight('http://localhost:8081');
    assert.equal(r.status, 204);
    assert.equal(r.headers.get('access-control-allow-origin'), 'http://localhost:8081');
    assert.equal(r.headers.get('access-control-allow-methods'), 'POST');
    assert.equal(r.headers.get('access-control-allow-headers'), 'authorization,content-type');
    assert.match(r.headers.get('vary') ?? '', /Origin/i);
    assert.equal(handlerCalls, 0, 'preflight never reaches the handler');
  });

  await test('OPTIONS preflight from the configured web origin is allowed', async () => {
    const r = await preflight(PROD_ORIGIN);
    assert.equal(r.status, 204);
    assert.equal(r.headers.get('access-control-allow-origin'), PROD_ORIGIN);
  });

  await test('OPTIONS preflight from an unlisted origin gets no Access-Control-Allow-Origin', async () => {
    for (const o of ['https://evil.example.com', 'http://localhost:3000', 'https://prodpulse-x-technico-industries-ltd1.vercel.app', 'null']) {
      const r = await preflight(o);
      assert.equal(r.headers.get('access-control-allow-origin'), null, o);
    }
  });

  await test('unauthenticated POST is rejected (401 UNAUTHENTICATED) — with CORS headers so the app can read the error', async () => {
    const r = await post('http://localhost:8081');
    assert.equal(r.status, 401);
    assert.equal(r.headers.get('access-control-allow-origin'), 'http://localhost:8081');
    const body: any = await r.json();
    assert.equal(body.error.status, 'UNAUTHENTICATED');
    assert.equal(body.error.details.category, 'AUTH_REQUIRED');
  });

  await test('non-admin POST is rejected (403 PERMISSION_DENIED) with CORS headers', async () => {
    const r = await post('http://localhost:8081', unsignedIdToken('sup1'));
    assert.equal(r.status, 403);
    assert.equal(r.headers.get('access-control-allow-origin'), 'http://localhost:8081');
    const body: any = await r.json();
    assert.equal(body.error.status, 'PERMISSION_DENIED');
    assert.equal(body.error.details.category, 'ADMIN_FORBIDDEN');
  });

  await test('authenticated admin POST reaches the handler and gets its answer, with CORS headers', async () => {
    const before = handlerCalls;
    const r = await post(PROD_ORIGIN, unsignedIdToken('admin1'));
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('access-control-allow-origin'), PROD_ORIGIN);
    const body: any = await r.json();
    assert.equal(body.result.reply, 'OK from handler');
    assert.equal(body.result.model, 'gemini-test');
    assert.equal(handlerCalls, before + 1);
  });

  await test('CORS is not authorization: an unlisted origin is not let in, and a listed one still needs admin', async () => {
    const r = await post('https://evil.example.com', unsignedIdToken('admin1'));
    // Server-to-server callers ignore CORS; the browser is what enforces it.
    // What matters: no allow-origin header for the unlisted origin, so a
    // browser page there can't read the answer.
    assert.equal(r.headers.get('access-control-allow-origin'), null);
    const r2 = await post(PROD_ORIGIN, unsignedIdToken('sup1'));
    assert.equal(r2.status, 403);
  });

  server.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main();
