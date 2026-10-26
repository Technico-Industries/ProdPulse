# ProdPulse AI backend (Cloud Functions)

One callable function, `prodPulseAI`, used by the web app's AI screen
(`src/screens/AIAssistantScreen.tsx` → `src/services/prodPulseAI.ts`).

```
browser (signed-in admin)
  └─ httpsCallable('prodPulseAI', { question, history })        no key, no queries
       └─ Cloud Function (functions/src)
            1. request.auth (Firebase ID token, verified by the runtime)
            2. users/{uid}: role === 'admin' && active !== false
            3. payload validation + per-user rate limit
            4. Gemini (@google/genai → generativelanguage.googleapis.com, key from Secret Manager)
                 ⇄ read-only tools (tools.ts) → Firestore via Admin SDK (dataSource.ts)
            5. { reply, results[], toolErrors[], dataRetrieved, model, generatedAt }
```

- **Shared business logic.** `npm run build` bundles `src/` here with
  esbuild, together with the app's `src/utils` (production date, de-duplication,
  efficiency, quality, downtime) and `src/constants/lineOptions`. The server
  computes exactly what the app's reports compute.
- **Timezone.** The plants are in India, and Cloud Functions run in UTC.
  `src/timezone.ts` sets `TZ=Asia/Kolkata` before any date is computed. You
  can override it with `PRODUCTION_TIMEZONE` in `functions/.env`.
- **Read-only.** There are no writes anywhere in `functions/src`. The tools
  read only `productionRecords`, `productionLines`, `activeSessions`,
  `rejectionRecords` and `users`.

## 1. Gemini API key (`GEMINI_API_KEY`)

Create a key in Google AI Studio (https://aistudio.google.com/apikey). The
key's Google Cloud project must have **billing in good standing**. If the
billing account has an outstanding balance, Gemini rejects calls, and the app
reports a Gemini billing problem (`AI_CONFIGURATION_ERROR · NO_CREDITS`).

The key is **server-side only**. Never put it in `app.json`, an
`EXPO_PUBLIC_*` variable, a root `.env` file or any file under `src/`,
because all of those ship to the browser. It is also separate from the
Firebase web `apiKey` in `src/services/firebase.ts`.

**Production (Secret Manager).** Run this once, and again whenever you rotate
the key:

```sh
npx firebase functions:secrets:set GEMINI_API_KEY --project technico-industries-ltd   # paste the key at the prompt
```

Redeploy the function after setting or rotating the key. Each deploy pins
the version that is latest at that moment.

**Local emulator.** Put the key in `functions/.secret.local`, which is
gitignored and never deployed:

```
GEMINI_API_KEY=your-key
```

If the key is missing or empty, requests fail with `AI_CONFIGURATION_ERROR ·
KEY_MISSING`. This check runs only after the caller passes authentication and
the admin check.

**Check a key without exposing it.** Run the local diagnostic. It reads the
key from stdin and prints only the HTTP status, Google's error status and
reason, and the model's reply:

```sh
npx firebase functions:secrets:access GEMINI_API_KEY --project technico-industries-ltd \
  | npm --prefix functions run -s diagnose:gemini -- gemini-3.8-flash
```

## 2. Model and API

- **API.** The Gemini Developer API `generateContent` endpoint, called with
  function calling through Google's official `@google/genai` SDK
  (`src/gemini.ts`). The key goes in the `x-goog-api-key` header, never in
  the URL.
- **Model.** The default is `gemini-3.8-flash`, the same model ProdPulse AI
  used before the xAI switch, and one of Google's stable models. To change
  it, set it in `functions/.env.technico-industries-ltd` or `functions/.env`:

  ```
  GEMINI_MODEL=gemini-3.5-flash-lite
  ```

  When you answer the deploy prompt for `GEMINI_MODEL`, enter a model name,
  not the key. A value that isn't a model ID is refused before any request
  (`MODEL_MISCONFIGURED`) and is never logged. An unknown model fails with
  `MODEL_UNAVAILABLE`.
- **Thought signatures.** `generateContent` is stateless. Each round resends
  the whole conversation, and the model's function-call turn goes back
  unchanged so its thought signatures are preserved.

**Retired xAI configuration.** `XAI_API_KEY` and `XAI_MODEL` are no longer
read. The next deploy drops the function's `XAI_API_KEY` binding and its
`XAI_MODEL` variable. Once Gemini is confirmed working, delete the old secret:

```sh
npx firebase functions:secrets:destroy XAI_API_KEY --project technico-industries-ltd
```

## 3. Allowed web origins (CORS)

The callable uses firebase-functions' built-in CORS support (the `cors`
option, see `src/cors.ts` / `src/options.ts`) with an **exact allowlist**
instead of the default, which allows every origin:

- `http://localhost:8081` (local Expo web) is always allowed.
- The deployed web app's origin(s) come from `PRODPULSE_WEB_ORIGINS` in
  `functions/.env`, comma-separated, scheme + host only:

  ```
  PRODPULSE_WEB_ORIGINS=https://your-production-domain.example
  ```

  Use the URL people actually open: the Vercel production domain or your
  custom domain. Per-deployment `prodpulse-<hash>-….vercel.app` URLs change
  on every deploy. Wildcards and patterns are rejected on purpose, because
  `*.vercel.app` names are first-come.

The preflight (`OPTIONS`) is answered without authentication. Every real
`POST` is still checked for a Firebase ID token and an active admin profile.
CORS only stops other websites' pages from calling the function from a
signed-in admin's browser; it is not access control.

Changing the list requires a redeploy.

## 4. Deploy

You need the Firebase CLI logged in (`npx firebase login`) and the project on
the **Blaze** plan, which Cloud Functions and Secret Manager require.

```sh
npm --prefix functions install
npx firebase deploy --only functions:prodPulseAI
```

`firebase.json` runs `npm run build` (the esbuild bundle) before every deploy.

**Permissions.** The function runs as the default compute service account.
In this project that account already has Firestore access through the Admin
SDK. The Admin SDK bypasses Firestore Security Rules, so authorization is
enforced in code (`handler.ts`). No security-rule changes are needed or made.
If you move the function to a dedicated service account, grant it
`roles/datastore.viewer` (read-only) and `roles/secretmanager.secretAccessor`
on `GEMINI_API_KEY`.

**Indexes.** None. Every query uses one single-field range, which Firestore's
automatic indexes serve.

## 5. Limits

| Limit | Value | Where |
| --- | --- | --- |
| Question length | 1,000 chars | `src/utils/prodPulseAI.ts` |
| History | 12 messages / 16,000 chars | `src/utils/prodPulseAI.ts` |
| Date range per tool | 92 days | `utils/modelPartProduction` |
| Docs per query | 20,000 | `dataSource.ts` |
| Tool rounds / calls per round | 5 / 4 | `assistant.ts` |
| Token budget per question | 120k | `assistant.ts` |
| Per Gemini call / whole request | 40 s / 75 s (function timeout 90 s) | `assistant.ts`, `index.ts` |
| Rate limit | 20 questions / 10 min per user per instance | `handler.ts` |
| Instances | max 3 | `index.ts` |

## 6. Local development

```sh
npm --prefix functions run serve       # builds, then starts the functions emulator on :5001
```

To point the web app at the emulator, set `EXPO_PUBLIC_USE_FUNCTIONS_EMULATOR=1`
in `.env.local` and run `npm run web`. The emulated function reads the
**production** Firestore with your local Google credentials
(`gcloud auth application-default login`), but it only reads.

## 7. Tests

```sh
npm run test:ai                        # from the repo root; Gemini and Firestore are mocked (no network)
npm run test:cors                      # preflight / CORS headers through the real onCall wrapper on localhost
```
