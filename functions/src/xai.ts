// functions/src/xai.ts
//
// The xAI (Grok) client: the official OpenAI SDK pointed at xAI's
// OpenAI-compatible API, calling the Responses API (xAI's recommended
// interface — Chat Completions is deprecated there). Server-side only.

import OpenAI from 'openai';
import { CALL_TIMEOUT_MS, CreateResponseFn } from './assistant';

export const XAI_BASE_URL = 'https://api.x.ai/v1';
export const XAI_RESPONSES_URL = `${XAI_BASE_URL}/responses`;
export const DEFAULT_XAI_MODEL = 'grok-4.7';

// The AI provider is not configured: XAI_API_KEY unset/empty, or XAI_MODEL
// not a model id.
export class AIConfigError extends Error {
  constructor(message: string, public reason: 'KEY_MISSING' | 'MODEL_MISCONFIGURED' = 'KEY_MISSING') {
    super(message);
    this.name = 'AIConfigError';
  }
}

// A model id looks like "grok-4.7" or "grok-4.20-0309-reasoning": lowercase
// letters, digits, dots and dashes. Anything else — notably an API key
// pasted into the XAI_MODEL prompt at deploy time — is refused before any
// request, and is never logged.
export function isPlausibleModelId(model: unknown): model is string {
  return typeof model === 'string' && /^[a-z][a-z0-9.-]{1,63}$/.test(model);
}

export function createXaiResponseFn(apiKey: string | undefined, fetchImpl?: typeof fetch): CreateResponseFn {
  const key = apiKey?.trim();
  if (!key) throw new AIConfigError('XAI_API_KEY is not set.');
  // One retry for transient failures; the loop's own deadline bounds the rest.
  const ai = new OpenAI({ apiKey: key, baseURL: XAI_BASE_URL, maxRetries: 1, timeout: CALL_TIMEOUT_MS, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
  return (request, { signal }) =>
    ai.responses.create(request as unknown as OpenAI.Responses.ResponseCreateParamsNonStreaming, { signal }) as unknown as ReturnType<CreateResponseFn>;
}
