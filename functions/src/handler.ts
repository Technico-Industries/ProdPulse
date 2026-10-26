// functions/src/handler.ts
//
// One prodPulseAI request, in order — nothing reaches Firestore production
// data or the AI provider (xAI Grok) until every check before it has passed:
//   1. a verified Firebase Auth identity (request.auth, checked by the
//      callable runtime from the ID token — never a client-sent uid);
//   2. an ACTIVE ADMIN, re-read from users/{uid} on the server with the
//      app's own rule (utils/endProduction isActiveAdmin — authStore
//      resolveProfile's rule). A client-sent role or isAdmin is never read;
//      validateAIRequest rejects any such field outright;
//   3. a valid, size-limited payload;
//   4. the per-user rate limit;
//   5. the Grok tool loop (assistant.ts).
// Errors leave as HttpsError codes with safe messages — no stack traces,
// API key, or provider error text.

import { HttpsError, FunctionsErrorCode } from 'firebase-functions/v2/https';
import { validateAIRequest, ProdPulseAIResponse, AIErrorCategory, AIErrorReason } from '../../src/utils/prodPulseAI';
import { isActiveAdmin } from '../../src/utils/endProduction';
import { AssistantError, CreateResponseFn, runAssistant } from './assistant';
import { APIConnectionTimeoutError, APIUserAbortError } from 'openai';
import type { ProductionDataSource } from './dataSource';
import { AIConfigError, isPlausibleModelId, XAI_RESPONSES_URL } from './xai';

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
// masked. xAI's messages ("Incorrect API key provided", "model ... does not
// exist", "doesn't have any credits") are what makes a failure diagnosable.
export function providerDetail(e: unknown): string {
  const msg = String((e as { message?: unknown })?.message ?? e ?? '');
  return msg.replace(/(?:xai-|grok_)[0-9A-Za-z_-]{16,}|AIza[0-9A-Za-z_-]{20,}|AQ\.[0-9A-Za-z_.-]{20,}|Bearer\s+\S+/g, '***').slice(0, 400);
}

// Maps an error from the xAI API (the OpenAI SDK's APIError carries the HTTP
// status, xAI's error code and the request id) or the loop to a callable
// error with a category and a precise reason (src/utils/prodPulseAI
// AIErrorReason). Order matters: a billing/credits message or an unknown
// model is recognised before the generic status rules.
export function toHttpsError(e: unknown): HttpsError {
  if (e instanceof HttpsError) return e;
  if (e instanceof AIConfigError) {
    return e.reason === 'MODEL_MISCONFIGURED'
      ? fail('failed-precondition', 'AI_CONFIGURATION_ERROR', 'The AI model setting (XAI_MODEL) is not a valid Grok model name. Ask the developer to fix XAI_MODEL.', 'MODEL_MISCONFIGURED')
      : fail('failed-precondition', 'AI_CONFIGURATION_ERROR', 'The AI service key is not configured. Ask the developer to set XAI_API_KEY.', 'KEY_MISSING');
  }
  if (e instanceof AssistantError) {
    if (e.kind === 'timeout') return fail('deadline-exceeded', 'TIMEOUT', 'ProdPulse AI took too long to answer. Try a narrower question or a shorter date range.', 'TIMEOUT');
    return fail('internal', 'INVALID_RESPONSE', 'ProdPulse AI returned an unexpected answer. Please try again.', 'INVALID_RESPONSE');
  }
  const status = typeof (e as { status?: unknown })?.status === 'number' ? (e as { status: number }).status : null;
  const name = (e as { name?: string })?.name ?? '';
  const text = providerDetail(e).toLowerCase();
  if (e instanceof APIUserAbortError || e instanceof APIConnectionTimeoutError || name === 'AbortError') {
    return fail('deadline-exceeded', 'TIMEOUT', 'ProdPulse AI took too long to answer. Please try again.', 'TIMEOUT');
  }
  if ((status === 400 || status === 402 || status === 403 || status === 429) && /billing|credits|spending limit|license|outstanding balance|prepayment/.test(text)) {
    return fail('failed-precondition', 'AI_CONFIGURATION_ERROR', 'The xAI account behind ProdPulse AI has no credits or a billing problem. Ask the developer to check billing in the xAI console.', 'NO_CREDITS');
  }
  if (status === 429) return fail('resource-exhausted', 'AI_API_ERROR', 'The AI service rate limit was reached. Try again in a few minutes.', 'RATE_LIMITED');
  if ((status === 400 || status === 404) && /model/.test(text) && /not exist|not found|does not have access|no access|not available|unsupported/.test(text)) {
    return fail('failed-precondition', 'AI_CONFIGURATION_ERROR', 'The configured Grok model is not available to this API key. Ask the developer to check XAI_MODEL.', 'MODEL_UNAVAILABLE');
  }
  if (status === 404) return fail('failed-precondition', 'AI_CONFIGURATION_ERROR', 'The configured Grok model or API endpoint is not available. Ask the developer to check XAI_MODEL.', 'MODEL_UNAVAILABLE');
  if (status === 401 || (status === 400 && /api key|apikey|unauthor/.test(text))) {
    return fail('failed-precondition', 'AI_CONFIGURATION_ERROR', 'The AI service rejected the API key as invalid. Ask the developer to replace XAI_API_KEY with a valid xAI API key.', 'KEY_INVALID');
  }
  if (status === 403) {
    return fail('failed-precondition', 'AI_CONFIGURATION_ERROR', 'The xAI API key is not allowed to use this API or model. Ask the developer to check the key permissions in the xAI console.', 'ACCESS_DENIED');
  }
  if (status === 400 || status === 422) return fail('internal', 'AI_API_ERROR', 'The AI service rejected the request. Please try again; if it keeps failing, contact the developer.', 'BAD_REQUEST');
  if (status != null && status >= 500) return fail('unavailable', 'AI_API_ERROR', 'The AI service is temporarily unavailable. Please try again.', 'PROVIDER_UNAVAILABLE');
  return fail('unavailable', 'AI_API_ERROR', 'Could not reach the AI service. Please try again.', 'NETWORK');
}

// What the server log records about a provider failure: status, xAI's own
// error code/type and request id (for xAI support) and the masked message.
// Never the key, the question or production data.
export function providerLogFields(e: unknown): Record<string, unknown> {
  const x = e as { status?: unknown; code?: unknown; type?: unknown; requestID?: unknown };
  return {
    providerStatus: typeof x?.status === 'number' ? x.status : null,
    providerCode: typeof x?.code === 'string' ? x.code : null,
    providerType: typeof x?.type === 'string' ? x.type : null,
    providerRequestId: typeof x?.requestID === 'string' ? x.requestID : null,
    detail: providerDetail(e),
  };
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export interface HandlerDeps {
  data: ProductionDataSource;
  // Built lazily, so the API key is only read once a request is authorised.
  // Throws AIConfigError when the key is missing.
  createResponse: () => CreateResponseFn;
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
    // A wrong XAI_MODEL (e.g. a key pasted into the deploy prompt) is refused
    // here, before any request to xAI, and its value is never logged.
    if (!isPlausibleModelId(deps.model)) throw new AIConfigError('XAI_MODEL is not a model id.', 'MODEL_MISCONFIGURED');
    return await runAssistant({
      question: check.value.question,
      history: check.value.history,
      model: deps.model,
      createResponse: deps.createResponse(),
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
      // model id, so a secret mistakenly put in XAI_MODEL never reaches the
      // log; keyConfigured says whether XAI_API_KEY had a non-empty value.
      endpoint: XAI_RESPONSES_URL,
      model: isPlausibleModelId(deps.model) ? deps.model : '<invalid XAI_MODEL — value not logged>',
      keyConfigured: details.reason !== 'KEY_MISSING',
      ...providerLogFields(e),
    });
    throw err;
  }
}
