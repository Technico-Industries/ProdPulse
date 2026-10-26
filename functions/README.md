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
            4. xAI Grok (OpenAI SDK → https://api.x.ai/v1/responses, key from Secret Manager)
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

## 1. xAI API key (`XAI_API_KEY`)

Create a key in the xAI console (https://console.x.ai). The team needs
**credits or billing set up**. Without them xAI rejects calls, and the app
says the xAI account has "no credits or a billing problem".

The key is **server-side only**. Never put it in `app.json`, an
`EXPO_PUBLIC_*` variable, a root `.env` file or any file under `src/`,
because all of those ship to the browser. It is also separate from the
Firebase web `apiKey` in `src/services/firebase.ts`.

**Production (Secret Manager).** Run this once, and again whenever you rotate
the key:

```sh
npx firebase functions:secrets:set XAI_API_KEY         # paste the key at the prompt
```

Redeploy the function after rotating so it picks up the new version.

**Local emulator.** Put the key in `functions/.secret.local`, which is
gitignored and never deployed:

```
XAI_API_KEY=your-key
```

If the key is missing or empty, requests fail with `AI_CONFIGURATION_ERROR`
("Ask the developer to set XAI_API_KEY"). This check runs only after the
caller passes authentication and the admin check.

## 2. Model and API

- **API.** xAI's Responses API (`POST https://api.x.ai/v1/responses`), called
  through the official `openai` npm SDK with `baseURL: https://api.x.ai/v1`
  (`src/xai.ts`). xAI recommends the Responses API; it marks Chat
  Completions as deprecated.
- **Stateless.** Every request sets `store: false`, so no question or
  production result is kept on xAI's servers. xAI's default is to store
  responses for 30 days. The loop resends the conversation each round
  instead, replaying the model's encrypted reasoning and function-call items
  unchanged (`include: ["reasoning.encrypted_content"]`).
- **Model.** The default is `grok-4.7`, xAI's recommended default model and
  the one its function-calling guide uses. To change it, create
  `functions/.env`:

  ```
  XAI_MODEL=grok-4.3
  ```

  If the model doesn't exist or the team has no access to it, requests fail
  with `AI_CONFIGURATION_ERROR` ("check XAI_MODEL").

**Retired Gemini configuration.** `GEMINI_API_KEY` and `GEMINI_MODEL` are no
longer read. If you stored `GEMINI_API_KEY` in Secret Manager, remove it after
the xAI version is deployed:

```sh
npx firebase functions:secrets:destroy GEMINI_API_KEY
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
on `XAI_API_KEY`.

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
| Per xAI call / whole request | 40 s / 75 s (function timeout 90 s) | `assistant.ts`, `index.ts` |
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
npm run test:ai                        # from the repo root; xAI and Firestore are mocked (no network)
npm run test:cors                      # preflight / CORS headers through the real onCall wrapper on localhost
```
