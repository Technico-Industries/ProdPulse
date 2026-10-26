// functions/src/cors.ts
//
// Which browser origins may call prodPulseAI. Uses the callable's built-in
// CORS support (onCall's `cors` option → the `cors` middleware, methods
// POST): it answers the OPTIONS preflight itself, before — and without —
// any authentication, and sets the headers before the handler runs, so error
// responses carry them too. An origin not listed gets no
// Access-Control-Allow-Origin and the browser blocks the call.
//
// CORS is NOT access control here: every real request is still checked for
// a Firebase ID token and an active admin profile (handler.ts). The list
// only stops other websites' pages from calling the function in a signed-in
// admin's browser.
//
// Exact origins only — no wildcard and no pattern: *.vercel.app names are
// first-come, so a pattern could match someone else's project.

export const LOCAL_DEV_ORIGINS = ['http://localhost:8081'];

// A full origin: scheme + host (+ port), nothing else.
const ORIGIN_RE = /^(https:\/\/[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+|http:\/\/localhost)(:\d{1,5})?$/;

export function isValidOrigin(v: string): boolean {
  return ORIGIN_RE.test(v);
}

// Local Expo web + the deployed web app's origin(s), from
// PRODPULSE_WEB_ORIGINS in functions/.env (comma-separated, e.g.
// "https://prodpulse.example.com"). Invalid entries are skipped and
// reported through `warn`.
export function allowedOrigins(
  env: Record<string, string | undefined> = process.env,
  warn: (msg: string) => void = () => {}
): string[] {
  const extra = (env.PRODPULSE_WEB_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim().replace(/\/+$/, '').toLowerCase())
    .filter(Boolean);
  const out = [...LOCAL_DEV_ORIGINS];
  for (const o of extra) {
    if (!isValidOrigin(o)) {
      warn(`Ignoring invalid PRODPULSE_WEB_ORIGINS entry "${o}" (expected e.g. https://app.example.com).`);
      continue;
    }
    if (!out.includes(o)) out.push(o);
  }
  if (!extra.length) warn('PRODPULSE_WEB_ORIGINS is not set — only local development (http://localhost:8081) may call prodPulseAI.');
  return out;
}
