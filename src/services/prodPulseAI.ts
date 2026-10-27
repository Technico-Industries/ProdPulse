// src/services/prodPulseAI.ts
//
// Client-side call into the secure ProdPulse AI backend (functions/src). This
// file contains NO API key and NO Firestore query logic — it only invokes
// the prodPulseAI callable Cloud Function, which verifies the signed-in user
// is an active admin, queries production data and calls the AI model (Gemini) server-side.

import { httpsCallable } from 'firebase/functions';
import { functions, firebaseConfig } from './firebase';
import {
  AIHistoryMessage,
  ProdPulseAIRequest,
  ProdPulseAIResponse,
  validateAIRequest,
  AIErrorCategory,
  AIErrorReason,
  classifyCallableError,
  isStatusZeroError,
} from '../utils/prodPulseAI';

// The backend's own limit is 90 s; this leaves room for the round trip.
const callProdPulseAI = httpsCallable<ProdPulseAIRequest, ProdPulseAIResponse>(functions, 'prodPulseAI', { timeout: 100_000 });

export class ProdPulseAIError extends Error {
  constructor(message: string, public retryable: boolean, public category: AIErrorCategory, public reason?: AIErrorReason) {
    super(message);
    this.name = 'ProdPulseAIError';
  }
}

// The callable's public URL — the Firebase SDK's own default (region
// us-central1, see getFunctions in ./firebase).
const FUNCTION_URL = `https://us-central1-${firebaseConfig.projectId}.cloudfunctions.net/prodPulseAI`;

// After a status-0 failure (fetch threw — CORS-blocked or no connection),
// asks whether the function's host answers at all. A no-cors request needs
// no CORS headers and sends no credentials or token; it resolves (opaque)
// whenever the server responds — even with 404 — and rejects only when it
// can't be reached. Not used against the local emulator.
async function probeFunctionHost(): Promise<boolean | null> {
  if (typeof fetch !== 'function' || (__DEV__ && process.env.EXPO_PUBLIC_USE_FUNCTIONS_EMULATOR === '1')) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    await fetch(FUNCTION_URL, { method: 'GET', mode: 'no-cors', cache: 'no-store', credentials: 'omit', signal: controller.signal });
    return true;
  } catch {
    return controller.signal.aborted ? null : false;
  } finally {
    clearTimeout(timer);
  }
}

// See utils/prodPulseAI classifyCallableError for how each failure is
// categorised (including the browser's "function missing" case).
export async function toProdPulseAIError(err: unknown): Promise<ProdPulseAIError> {
  const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
  const reachable = !offline && isStatusZeroError(err) ? await probeFunctionHost() : null;
  const c = classifyCallableError(err, offline, reachable);
  return new ProdPulseAIError(c.message, c.retryable, c.category, c.reason);
}

function logFailure(e: ProdPulseAIError, raw: unknown) {
  // Category and Firebase error code only — never the ID token or request.
  const code = (raw as { code?: string })?.code ?? null;
  if (__DEV__) {
    console.error('[ProdPulseAI] request failed', { category: e.category, reason: e.reason ?? null, code, message: (raw as { message?: string })?.message ?? String(raw) });
  } else {
    console.warn('[ProdPulseAI] request failed', { category: e.category, reason: e.reason ?? null, code });
  }
}

/**
 * Sends a question (plus the earlier turns of this conversation, text only)
 * to the backend. Throws ProdPulseAIError with a user-safe message.
 */
export async function askProdPulseAI(question: string, history: AIHistoryMessage[]): Promise<ProdPulseAIResponse> {
  const check = validateAIRequest({ question, history });
  if (!check.ok) throw new ProdPulseAIError(check.error, false, 'INVALID_REQUEST');
  let data: ProdPulseAIResponse;
  try {
    data = (await callProdPulseAI(check.value)).data;
  } catch (raw) {
    const e = await toProdPulseAIError(raw);
    logFailure(e, raw);
    throw e;
  }
  if (!data || typeof data.reply !== 'string' || !Array.isArray(data.results)) {
    const e = new ProdPulseAIError('Prod AI returned an unexpected answer. Please try again.', true, 'INVALID_RESPONSE');
    logFailure(e, 'response shape');
    throw e;
  }
  return data;
}
