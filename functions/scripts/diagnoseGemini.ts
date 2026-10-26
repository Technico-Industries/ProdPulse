// functions/scripts/diagnoseGemini.ts
//
// Local, read-only diagnosis of the Gemini configuration prodPulseAI uses.
// Not deployed (functions/scripts is excluded from the upload), so there is
// no diagnostic endpoint. The key is read from STDIN — pipe it straight from
// Secret Manager so it never appears in the shell history, argv or output:
//
//   npx firebase functions:secrets:access GEMINI_API_KEY --project technico-industries-ltd \
//     | npm --prefix functions run -s diagnose:gemini -- gemini-3.8-flash
//
// Prints only: whether a key is present, whether the model is visible to it,
// and the result of one tiny generateContent request. Never the key (it is
// sent in the x-goog-api-key header, not the URL), and no Firestore access.

import { DEFAULT_GEMINI_MODEL, GEMINI_BASE_URL, geminiEndpoint, isPlausibleModelId } from '../src/gemini';
import { googleErrorInfo, providerDetail } from '../src/handler';

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function call(url: string, key: string, init: RequestInit = {}) {
  const res = await fetch(url, {
    ...init,
    headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, body, text };
}

// Google's error body → status / ErrorInfo reason / masked message.
const errorOf = (r: { text: string }) => {
  const info = googleErrorInfo({ message: r.text });
  let message: string | null = null;
  try { message = JSON.parse(r.text)?.error?.message ?? null; } catch { /* ignore */ }
  return JSON.stringify({ status: info.status, reason: info.reason, message: message ? providerDetail(message) : null });
};

async function main() {
  const raw = await readStdin();
  const key = raw.trim();
  const modelArg = process.argv[2] ?? process.env.GEMINI_MODEL ?? DEFAULT_GEMINI_MODEL;
  const model = isPlausibleModelId(modelArg) ? modelArg : null;

  console.log('1. Key');
  console.log(`   present: ${key.length > 0}  surrounding whitespace trimmed: ${raw !== key}`);
  console.log(`   model: ${model ?? '<invalid model id — value not shown>'}`);
  if (!key) return void console.log('   → No key on stdin. Pipe it from Secret Manager (see the header of this file).');
  if (!model) return void console.log('   → Fix GEMINI_MODEL first (it is not a model id).');

  console.log(`2. GET ${GEMINI_BASE_URL}/v1beta/models/${model}  (model visible to this key)`);
  const m = await call(`${GEMINI_BASE_URL}/v1beta/models/${encodeURIComponent(model)}`, key);
  console.log(`   HTTP ${m.status}${m.status === 200 ? `  name: ${m.body?.name ?? '—'}  displayName: ${m.body?.displayName ?? '—'}` : `  error: ${errorOf(m)}`}`);

  console.log(`3. POST ${geminiEndpoint(model)}  (tiny request)`);
  const r = await call(geminiEndpoint(model), key, {
    method: 'POST',
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Reply with the single word OK.' }] }], generationConfig: { maxOutputTokens: 16 } }),
  });
  const reply = (r.body?.candidates?.[0]?.content?.parts ?? []).map((p: any) => p?.text ?? '').join('').trim();
  console.log(`   HTTP ${r.status}${r.status === 200 ? `  modelVersion: ${r.body?.modelVersion ?? '—'}  reply: ${JSON.stringify(reply.slice(0, 40))}` : `  error: ${errorOf(r)}`}`);
}

main().catch((e) => {
  console.log(`Diagnosis failed: ${providerDetail(String(e?.message ?? e))}`);
  process.exit(1);
});
