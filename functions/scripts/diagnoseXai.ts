// functions/scripts/diagnoseXai.ts
//
// Local, read-only diagnosis of the xAI configuration prodPulseAI uses. Not
// deployed (functions/scripts is excluded from the upload), so there is no
// diagnostic endpoint. The key is read from STDIN — pipe it straight from
// Secret Manager so it never appears in the shell history, argv or output:
//
//   npx firebase functions:secrets:access XAI_API_KEY --project technico-industries-ltd \
//     | npm --prefix functions run -s diagnose:xai -- grok-4.7
//
// Prints only: key shape (prefix class), xAI's key-status flags and ACLs,
// whether the model is available, and the result of one 16-token request
// (store: false). Never the key, the Authorization header, or production
// data — no Firestore access at all.

import { XAI_BASE_URL, DEFAULT_XAI_MODEL, isPlausibleModelId } from '../src/xai';
import { providerDetail } from '../src/handler';

const mask = (s: string) => providerDetail(s);

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function call(path: string, key: string, init: RequestInit = {}) {
  const res = await fetch(`${XAI_BASE_URL}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(30_000),
  });
  let body: any = null;
  try { body = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, requestId: res.headers.get('x-request-id'), body };
}

const errorOf = (body: any) =>
  body ? mask(JSON.stringify({ code: body.code ?? body.error?.code ?? null, error: typeof body.error === 'string' ? body.error : body.error?.message ?? body.message ?? null })) : null;

async function main() {
  const raw = await readStdin();
  const key = raw.trim();
  const modelArg = process.argv[2] ?? process.env.XAI_MODEL ?? DEFAULT_XAI_MODEL;
  const model = isPlausibleModelId(modelArg) ? modelArg : null;

  console.log('1. Key');
  console.log(`   present: ${key.length > 0}  prefix: ${/^xai-/.test(key) ? 'xai- (xAI API key format)' : key ? 'NOT xai- (not the xAI API key format)' : '—'}  surrounding whitespace trimmed: ${raw !== key}`);
  console.log(`   model: ${model ?? '<invalid model id — value not shown>'}`);
  if (!key) return void console.log('   → No key on stdin. Pipe it from Secret Manager (see the header of this file).');

  console.log(`2. GET ${XAI_BASE_URL}/api-key  (key status)`);
  const info = await call('/api-key', key);
  console.log(`   HTTP ${info.status}${info.requestId ? `  request-id ${info.requestId}` : ''}`);
  if (info.status === 200 && info.body) {
    const b = info.body;
    console.log(`   name: ${b.name ?? '—'}  api_key_blocked: ${b.api_key_blocked}  api_key_disabled: ${b.api_key_disabled}  team_blocked: ${b.team_blocked}`);
    console.log(`   acls: ${Array.isArray(b.acls) ? b.acls.join(', ') || '(none)' : '—'}`);
  } else {
    console.log(`   error: ${errorOf(info.body)}`);
  }

  if (!model) return void console.log('   → Fix XAI_MODEL first (it is not a model id).');

  console.log(`3. GET ${XAI_BASE_URL}/models/${model}  (model access)`);
  const m = await call(`/models/${encodeURIComponent(model)}`, key);
  console.log(`   HTTP ${m.status}${m.status === 200 ? `  id: ${m.body?.id ?? '—'}  owned_by: ${m.body?.owned_by ?? '—'}` : `  error: ${errorOf(m.body)}`}`);

  console.log(`4. POST ${XAI_BASE_URL}/responses  (16-token request, store: false)`);
  const r = await call('/responses', key, {
    method: 'POST',
    body: JSON.stringify({ model, input: [{ role: 'user', content: 'Reply with the single word OK.' }], max_output_tokens: 16, store: false }),
  });
  const text = (r.body?.output ?? [])
    .flatMap((o: any) => (o?.type === 'message' ? o.content ?? [] : []))
    .filter((c: any) => c?.type === 'output_text')
    .map((c: any) => c.text)
    .join('')
    .trim();
  console.log(`   HTTP ${r.status}${r.requestId ? `  request-id ${r.requestId}` : ''}${r.status === 200 ? `  model: ${r.body?.model ?? '—'}  reply: ${JSON.stringify(text.slice(0, 40))}` : `  error: ${errorOf(r.body)}`}`);
}

main().catch((e) => {
  console.log(`Diagnosis failed: ${mask(String(e?.message ?? e))}`);
  process.exit(1);
});
