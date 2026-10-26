// functions/src/gemini.ts
//
// The Gemini client: Google's official Gen AI SDK (@google/genai) against
// the Gemini Developer API (generativelanguage.googleapis.com), using
// generateContent with function calling. Server-side only — the key comes
// from the GEMINI_API_KEY secret binding.

import { GoogleGenAI } from '@google/genai';
import { CALL_TIMEOUT_MS, GenerateFn } from './assistant';

export const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com';
export const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';

export function geminiEndpoint(model: string): string {
  return `${GEMINI_BASE_URL}/v1beta/models/${model}:generateContent`;
}

// The AI provider is not configured: GEMINI_API_KEY unset/empty, or
// GEMINI_MODEL not a model id.
export class AIConfigError extends Error {
  constructor(message: string, public reason: 'KEY_MISSING' | 'MODEL_MISCONFIGURED' = 'KEY_MISSING') {
    super(message);
    this.name = 'AIConfigError';
  }
}

// A model id looks like "gemini-3.8-flash" or "gemini-3.5-flash-lite":
// lowercase letters, digits, dots and dashes. Anything else — notably an API
// key pasted into the GEMINI_MODEL prompt at deploy time — is refused before
// any request, and is never logged.
export function isPlausibleModelId(model: unknown): model is string {
  return typeof model === 'string' && /^[a-z][a-z0-9.-]{1,63}$/.test(model);
}

export function createGeminiGenerateFn(apiKey: string | undefined, fetchImpl?: typeof fetch): GenerateFn {
  const key = apiKey?.trim();
  if (!key) throw new AIConfigError('GEMINI_API_KEY is not set.');
  const ai = new GoogleGenAI({
    apiKey: key,
    httpOptions: { timeout: CALL_TIMEOUT_MS, ...(fetchImpl ? { fetch: fetchImpl as never } : {}) },
  });
  return (params) => ai.models.generateContent(params as Parameters<typeof ai.models.generateContent>[0]);
}
