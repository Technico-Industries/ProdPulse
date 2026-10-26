// functions/src/index.ts
//
// ProdPulse AI backend — one callable function, prodPulseAI, used by the web
// app's AI screen (src/services/prodPulseAI.ts). The AI provider is xAI
// (Grok) through its OpenAI-compatible Responses API (xai.ts). See
// functions/README.md for setup (XAI_API_KEY secret, model, deploy).

// Must run before anything computes a date — see timezone.ts.
import './timezone';

import { onCall } from 'firebase-functions/v2/https';
import { defineSecret, defineString } from 'firebase-functions/params';
import { logger } from 'firebase-functions';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { firestoreDataSource } from './dataSource';
import { createRateLimiter, handleProdPulseAI } from './handler';
import type { CreateResponseFn } from './assistant';
import { createXaiResponseFn, DEFAULT_XAI_MODEL } from './xai';
import { callableOptions } from './options';

// Server-side only: stored in Cloud Secret Manager (production) or
// functions/.secret.local (emulator). Never sent to the client.
const XAI_API_KEY = defineSecret('XAI_API_KEY');
const XAI_MODEL = defineString('XAI_MODEL', { default: DEFAULT_XAI_MODEL });

initializeApp();
const db = getFirestore();
const rateLimit = createRateLimiter();

let createResponse: CreateResponseFn | null = null;

export const prodPulseAI = onCall(
  {
    ...callableOptions(process.env, (msg) => logger.warn(`[prodPulseAI] ${msg}`)),
    secrets: [XAI_API_KEY],
  },
  (request) =>
    handleProdPulseAI(request, {
      data: firestoreDataSource(db),
      // Throws AIConfigError (→ AI_CONFIGURATION_ERROR) when the key is missing.
      createResponse: () => (createResponse ??= createXaiResponseFn(XAI_API_KEY.value())),
      model: XAI_MODEL.value(),
      rateLimit,
      // Metadata and (masked) provider error text only — never the question,
      // results, ID tokens or keys.
      log: (msg, meta) => {
        const { level, ...rest } = meta ?? {};
        (level === 'error' ? logger.error : logger.info)(`[prodPulseAI] ${msg}`, { uid: request.auth?.uid ?? null, ...rest });
      },
    })
);
