# Deployment — Talk to the Dead (PoC)

This app is a Next.js (Pages Router) app with:
- a public frontend (login, dashboard, chat),
- a serverless API route `pages/api/chat.ts` (`POST /api/chat`, SSE streaming),
- a Firebase Auth + Cloud Firestore backend.

The recommended host is **Vercel** because the `/api/chat` route is a Next.js
serverless function; Firebase Hosting alone cannot run it without additional
Cloud Functions wiring.

## Status

| Layer | State |
|---|---|
| Cloud Firestore security rules | **Deployed** to `be-right-back-b47be` (`firebase deploy --only firestore:rules`) |
| Cloud Firestore indexes | Declared in `firestore.indexes.json`; deployed with the rules command above |
| App (frontend + API route) | Not yet deployed — follow the runbook below |

## Prerequisites

1. A [Vercel](https://vercel.com) account (free tier is fine for a PoC).
2. This repo pushed to GitHub (`origin` = `https://github.com/ankurmishra32/talk-to-the-dead-poc.git`).
3. A hosted LLM configured (see "LLM for production" below). The out-of-the-box
   default points at localhost, which does not exist in the cloud.
4. Firebase project facts (already configured):
   - Project ID: `be-right-back-b47be`
   - Firebase Auth with **email/password** enabled
   - A Firestore named database `talk-to-the-dead`

## Runbook

### 1. Link the repo on Vercel

1. Go to https://vercel.com/new and import `ankurmishra32/talk-to-the-dead-poc`.
2. Framework preset: **Next.js** is auto-detected. Do **not** override build/output.
   (There is intentionally no `vercel.json` — Vercel auto-detects Next.js.)
3. Leave the default build command; no root directory override (the Next.js app
   is at the repo root).

### 2. Set environment variables

Set these in the Vercel project → Settings → Environment Variables, for
**Production** (and Preview if desired). Vercel ignores `.env.local`, so these
must be entered in the dashboard.

| Variable | Required | Notes |
|---|---|---|
| `NEXT_PUBLIC_FIREBASE_API_KEY` | yes | Browser key — public by design. Same value as `FIREBASE_API_KEY`. |
| `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN` | no (default) | default `be-right-back-b47be.firebaseapp.com` |
| `NEXT_PUBLIC_FIREBASE_PROJECT_ID` | no (default) | default `be-right-back-b47be` |
| `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET` | no (default) | default `be-right-back-b47be.appspot.com` |
| `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID` | optional | if configured locally |
| `NEXT_PUBLIC_FIREBASE_APP_ID` | yes (if auth uses it) | from Firebase console → Project settings |
| `FIREBASE_API_KEY` | yes | Server-side — the same browser key; read by `lib/firestore.ts` and `lib/auth/firebase.server.ts`. Throws if missing. |
| `FIREBASE_PROJECT_ID` | no (default) | default `be-right-back-b47be` |
| `FIREBASE_DATABASE_ID` | no (default) | default `talk-to-the-dead` |
| `LLM_PROVIDER` | yes | `lm-studio` or `ollama`. See "LLM for production". |
| `LM_STUDIO_BASE_URL` | depends | only if `LLM_PROVIDER=lm-studio` (default `http://localhost:1234/v1`) |
| `LM_STUDIO_MODEL` | depends | only if `LLM_PROVIDER=lm-studio` (default `qwen3.5:9b`) |
| `LM_STUDIO_API_KEY` | optional | if the hosted LM Studio-compatible endpoint needs a key |
| `OLLAMA_HOST` | depends | only if `LLM_PROVIDER=ollama` (default `http://localhost:11434`) |
| `OLLAMA_MODEL` | depends | only if `LLM_PROVIDER=ollama` (default `llama3.2`) |
| `AUTH_PROVIDER` | no (default) | `firebase` |

> **Important:** the default `LLM_PROVIDER=lm-studio` and `OLLAMA_HOST`/
> `LM_STUDIO_BASE_URL` point at `localhost`. In the cloud those hosts do not
> exist, so the API route will fail unless you set up a real, reachable LLM.

### 3. LLM for production

Vercel serverless functions cannot reach your local machine. Use a hosted model:

- **MiniMax M3 (recommended for this PoC):** point the adapter at MiniMax's
  API. If MiniMax exposes an OpenAI-compatible `/v1/chat/completions` endpoint,
  set `LLM_PROVIDER=lm-studio` (it is OpenAI-compatible) with
  `LM_STUDIO_BASE_URL=<minimax api base>` and `LM_STUDIO_MODEL=minimax/...`,
  plus `LM_STUDIO_API_KEY=<key>`.
- **Any other OpenAI-compatible host:** same pattern — set `LLM_PROVIDER=lm-studio`
  with the host's base URL, model id, and API key.
- **Ollama cloud:** if you intend to use Ollama's managed/cloud models, set
  `LLM_PROVIDER=ollama` with the appropriate `OLLAMA_HOST` and `OLLAMA_MODEL`.
  This is not reachable from Vercel unless Ollama is hosted remotely.

For a quick validation without spending, a local model only works on `localhost`
(this app's dev mode); for a publicly deployed PoC you need one of the above.

### 4. Restrict the Firebase API key by HTTP referrer

In Google Cloud Console → APIs & Services → Credentials, restrict the browser
key to the Identity Toolkit + Cloud Firestore APIs and allow your deployed
domain (e.g. `https://<project>.vercel.app/*` and/or a custom domain) as an
HTTP referrer. This is the real protection for the public key.

### 5. Deploy

```bash
vercel --prod
```

or push to `main` if a git-integrated deployment is set up in the Vercel
dashboard (it will auto-deploy).

### 6. Verify

- Load the deployed URL → sign up / sign in.
- Create a persona and send a message; confirm the reply streams token-by-token.
- If the chat errors, check Vercel function logs — the most common cause is the
  LLM provider not being reachable from the serverless function (step 3).

## Notes / gotchas

- **No `vercel.json`** — adding one can override Next.js defaults and break the
  build. Vercel detects Next.js automatically.
- **`.env.local` is gitignored** and Vercel ignores it; all vars must be entered
  in the dashboard.
- **Rate limiting is in-process** (`lib/rate-limit.ts`) — each serverless
  instance has its own counter. Fine for a personal PoC; swap for a shared store
  (Redis) before real traffic (see `prd.md` §9 Known Gaps).
- **Firestore rules must stay deployed** before any real user data flows
  (already done — redeploy if you edit `firestore.rules`).
