// functions/src/options.ts
//
// prodPulseAI's callable options (everything except the secret), shared by
// index.ts and the tests so both exercise the same CORS configuration.

import { allowedOrigins } from './cors';

export function callableOptions(env: Record<string, string | undefined> = process.env, warn?: (msg: string) => void) {
  return {
    // Exact allowed origins (cors.ts) instead of the default `true`, which
    // reflects any origin.
    cors: allowedOrigins(env, warn),
    timeoutSeconds: 90,
    memory: '512MiB' as const,
    maxInstances: 3,
    concurrency: 20,
  };
}
