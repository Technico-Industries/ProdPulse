// functions/src/handler.ts
//
// One prodPulseAI request, in order — nothing reaches Firestore production
// data or the AI provider (Gemini) until every check before it has passed:
//   1. a verified Firebase Auth identity (request.auth, checked by the
//      callable runtime from the ID token — never a client-sent uid);
//   2. an ACTIVE ADMIN, re-read from users/{uid} on the server with the
//      app's own rule (utils/endProduction isActiveAdmin — authStore
//      resolveProfile's rule). A client-sent role or isAdmin is never read;
//      validateAIRequest rejects any such field outright;
//   3. a valid, size-limited payload;
//   4. the per-user rate limit;
//   5. the Gemini tool loop (assistant.ts).
// Errors leave as HttpsError codes with safe messages — no stack traces,
// API key, or provider error text.

import { HttpsError, FunctionsErrorCode } from 'firebase-functions/v2/https';
import { validateAIRequest, ProdPulseAIResponse, AIErrorCategory, AIErrorReason } from '../../src/utils/prodPulseAI';
import { isActiveAdmin } from '../../src/utils/endProduction';
import { AssistantError, GenerateFn, runAssistant } from './assistant';
import type { ProductionDataSource } from './dataSource';
import { AIConfigError, geminiEndpoint, isPlausibleModelId } from './gemini';

export { AIConfigError };

// ─── Rate limit ──────────────────────────────────────────────────────────────
// Per user, per function instance (maxInstances caps instances, so this
// bounds total spend). Sliding window.

export const RATE_LIMIT = { max: 20, windowMs: 10 * 60 * 1000 };

export function createRateLimiter(limit = RATE_LIMIT) {
  const hits = new Map<string, number[]>();
  return (uid: string, nowMs: number): boolean => {
    const recent = (hits.get(uid) ?? []).filter((t) => nowMs - t < limit.windowMs);
    if (recent.length >= limit.max) {
      hits.set(uid, recent);
      return false;
    }
    recent.push(nowMs);
    hits.set(uid, recent);
    return true;
  };
}

// ─── Errors ──────────────────────────────────────────────────────────────────
// Every error leaves with a fixed, user-safe message and details.category
// (src/utils/prodPulseAI AIErrorCategory), so the client can say what went
// wrong without ever seeing provider text, stack traces or keys.

function fail(code: FunctionsErrorCode, category: AIErrorCategory, message: string, reason?: AIErrorReason): HttpsError {
  return new HttpsError(code, message, reason ? { category, reason } : { category });
}

// Provider error text for the SERVER log only, with anything key-shaped
// masked (Google API keys "AIza…"/"AQ.…", xAI-style keys, bearer tokens).
// Gemini's messages ("API key not valid", "models/x is not found",
// "billing account has an outstanding balance") make a failure diagnosable.
export function providerDetail(e: unknown): string {
  const msg = String((e as { message?: unknown })?.message ?? e ?? '');
  return msg.replace(/(?:xai-|grok_)[0-9A-Za-z_-]{16,}|AIza[0-9A-Za-z_-]{20,}|AQ\.[0-9A-Za-z_.-]{20,}|Bearer\s+\S+/g, '***').slice(0, 400);
}

// The Gemini SDK's ApiError carries the HTTP status, and its message embeds
// Google's JSON error body: {"error":{"code","message","status","details":
// [{"reason":"API_KEY_INVALID",…}]}}. Pull out the status string and the
// ErrorInfo reason — the most precise signal Google gives.
export function googleErrorInfo(e: unknown): { status: string | null; reason: string | null } {
  const msg = String((e as { message?: unknown })?.message ?? '');
  const start = msg.indexOf('{');
  if (start < 0) return { status: null, reason: null };
  try {
    const body = JSON.parse(msg.slice(start));
    const err = body?.error ?? body;
    const info = Array.isArray(err?.details) ? err.details.find((d: any) => typeof d?.reason === 'string') : null;
    return {
      status: typeof err?.status === 'string' ? err.status : null,
      reason: typeof info?.reason === 'string' ? info.reason : null,
    };
  } catch {
    return { status: null, reason: null };
  }
}

// Maps an error from the Gemini API or the loop to a callable error with a
// category and a precise reason (src/utils/prodPulseAI AIErrorReason). Order
// matters: billing and unknown-model messages are recognised before the
// generic status rules.
export function toHttpsError(e: unknown): HttpsError {
  if (e instanceof HttpsError) return e;
  if (e instanceof AIConfigError) {
    return e.reason === 'MODEL_MISCONFIGURED'
      ? fail('failed-precondition', 'AI_CONFIGURATION_ERROR', 'The AI model setting (GEMINI_MODEL) is not a valid Gemini model name. Ask the developer to fix GEMINI_MODEL.', 'MODEL_MISCONFIGURED')
      : fail('failed-precondition', 'AI_CONFIGURATION_ERROR', 'The AI service key is not configured. Ask the developer to set GEMINI_API_KEY.', 'KEY_MISSING');
  }
  if (e instanceof AssistantError) {
    if (e.kind === 'timeout') return fail('deadline-exceeded', 'TIMEOUT', 'ProdPulse AI took too long to answer. Try a narrower question or a shorter date range.', 'TIMEOUT');
    return fail('internal', 'INVALID_RESPONSE', 'ProdPulse AI returned an unexpected answer. Please try again.', 'INVALID_RESPONSE');
  }
  const status = typeof (e as { status?: unknown })?.status === 'number' ? (e as { status: number }).status : null;
  const name = (e as { name?: string })?.name ?? '';
  const text = providerDetail(e).toLowerCase();
  const google = googleErrorInfo(e);
  if (name === 'AbortError' || name === 'TimeoutError') {
    return fail('deadline-exceeded', 'TIMEOUT', 'ProdPulse AI took too long to answer. Please try again.', 'TIMEOUT');
  }
  if ((status === 400 || status === 403 || status === 429) && /billing|outstanding balance|prepayment|credits|free tier is not available/.test(text)) {
    return fail('failed-precondition', 'AI_CONFIGURATION_ERROR', 'The Gemini account behind ProdPulse AI has a billing problem. Ask the developer to check billing in Google AI Studio.', 'NO_CREDITS');
  }
  if (status === 429) return fail('resource-exhausted', 'AI_API_ERROR', 'The Gemini rate limit or quota was reached. Try again in a few minutes.', 'RATE_LIMITED');
  if (status === 404 || ((status === 400 || status === 403) && /model/.test(text) && /not found|not supported|does not exist|not available/.test(text))) {
    return fail('failed-precondition', 'AI_CONFIGURATION_ERROR', 'The configured Gemini model is not available. Ask the developer to check GEMINI_MODEL.', 'MODEL_UNAVAILABLE');
  }
  if (status === 401 || google.reason === 'API_KEY_INVALID' || (status === 400 && /api key not valid|api_key_invalid|invalid api key/.test(text))) {
    return fail('failed-precondition', 'AI_CONFIGURATION_ERROR', 'Gemini rejected the API key as invalid. Ask the developer to replace GEMINI_API_KEY with a valid key from Google AI Studio.', 'KEY_INVALID');
  }
  if (status === 403) {
    return fail('failed-precondition', 'AI_CONFIGURATION_ERROR', 'The Gemini API key is not allowed to use the Gemini API (key restrictions, or the API is disabled for its project). Ask the developer to check the key in Google AI Studio.', 'ACCESS_DENIED');
  }
  if (status === 400) return fail('internal', 'AI_API_ERROR', 'The AI service rejected the request. Please try again; if it keeps failing, contact the developer.', 'BAD_REQUEST');
  // 504 DEADLINE_EXCEEDED: Gemini accepted the request but the model did not
  // finish before the deadline we send (X-Server-Timeout = CALL_TIMEOUT_MS).
  // That is a timeout, not an outage.
  if (status === 504 || google.status === 'DEADLINE_EXCEEDED') {
    return fail('deadline-exceeded', 'TIMEOUT', 'Gemini did not finish answering in time. Please try again; if it keeps happening, the developer should check GEMINI_MODEL.', 'TIMEOUT');
  }
  if (status != null && status >= 500) return fail('unavailable', 'AI_API_ERROR', 'The AI service is temporarily unavailable. Please try again.', 'PROVIDER_UNAVAILABLE');
  return fail('unavailable', 'AI_API_ERROR', 'Could not reach the AI service. Please try again.', 'NETWORK');
}

// What the server log records about a provider failure: HTTP status,
// Google's status string and ErrorInfo reason, and the masked message.
// Never the key, the question or production data.
export function providerLogFields(e: unknown): Record<string, unknown> {
  const google = googleErrorInfo(e);
  return {
    providerStatus: typeof (e as { status?: unknown })?.status === 'number' ? (e as { status: number }).status : null,
    providerCode: google.status,
    providerReason: google.reason,
    detail: providerDetail(e),
  };
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export interface HandlerDeps {
  data: ProductionDataSource;
  // Built lazily, so the API key is only read once a request is authorised.
  // Throws AIConfigError when the key is missing.
  generate: () => GenerateFn;
  model: string;
  rateLimit: (uid: string, nowMs: number) => boolean;
  now?: () => number;
  log?: (msg: string, meta?: Record<string, unknown>) => void;
}

export async function handleProdPulseAI(
  request: { auth?: { uid?: string } | null; data: unknown },
  deps: HandlerDeps
): Promise<ProdPulseAIResponse> {
  const uid = request.auth?.uid;
  if (!uid) throw fail('unauthenticated', 'AUTH_REQUIRED', 'Sign in to use ProdPulse AI.');

  let profile: Record<string, any> | null;
  try {
    profile = await deps.data.getUserProfile(uid);
  } catch (e) {
    deps.log?.('profile read failed', { level: 'error', category: 'FIRESTORE_QUERY_ERROR', detail: providerDetail(e) });
    throw fail('unavailable', 'FIRESTORE_QUERY_ERROR', 'Could not verify your account. Please try again.');
  }
  if (!isActiveAdmin(profile)) throw fail('permission-denied', 'ADMIN_FORBIDDEN', 'ProdPulse AI is available to active admin accounts only.');

  const check = validateAIRequest(request.data);
  if (!check.ok) throw fail('invalid-argument', 'INVALID_REQUEST', check.error);

  const now = deps.now?.() ?? Date.now();
  if (!deps.rateLimit(uid, now)) {
    throw fail('resource-exhausted', 'RATE_LIMITED', 'Too many questions in a short time. Wait a few minutes and try again.');
  }

  try {
    // A wrong GEMINI_MODEL (e.g. a key pasted into the deploy prompt) is
    // refused here, before any request to Gemini, and its value is never
    // logged.
    if (!isPlausibleModelId(deps.model)) throw new AIConfigError('GEMINI_MODEL is not a model id.', 'MODEL_MISCONFIGURED');
    return await runAssistant({
      question: check.value.question,
      history: check.value.history,
      model: deps.model,
      generate: deps.generate(),
      data: deps.data,
      nowMs: now,
      log: deps.log,
    });
  } catch (e) {
    const err = toHttpsError(e);
    const details = (err.details ?? {}) as { category?: string; reason?: string };
    deps.log?.('request failed', {
      level: 'error',
      code: err.code,
      category: details.category ?? null,
      reason: details.reason ?? null,
      kind: (e as AssistantError)?.kind ?? null,
      // Request context. The model is logged only when it is a plausible
      // model id, so a secret mistakenly put in GEMINI_MODEL never reaches
      // the log; keyConfigured says whether GEMINI_API_KEY had a value.
      endpoint: isPlausibleModelId(deps.model) ? geminiEndpoint(deps.model) : null,
      model: isPlausibleModelId(deps.model) ? deps.model : '<invalid GEMINI_MODEL — value not logged>',
      keyConfigured: details.reason !== 'KEY_MISSING',
      ...providerLogFields(e),
    });
    throw err;
  }
}
