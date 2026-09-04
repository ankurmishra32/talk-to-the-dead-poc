---
name: pocttd
description: Use only when working on the talk-to-the-dead-poc project, an AI persona-simulation chatbot. Covers its Next.js Pages Router stack, Firebase Auth/Firestore backend, SSE streaming chat, the lib/llm adapter, persona/prompt design, rate limiting, and its test/CI setup. Trigger on the project's own work; this skill complements (does not replace) the project's AGENTS.md.
---

# talk-to-the-dead-poc

An AI chatbot that simulates a deceased person from user-supplied memories and
observed ways of speaking. The defining requirement is **model behavior, not
catchphrases** — a convincingly in-character, emotionally sensitive response
grounded in evidence, never a generic chatbot that occasionally repeats a
phrase.

## Stack & architecture

- Next.js 16, **Pages Router** (not App Router), React 19, TypeScript,
  Tailwind CSS.
- Firebase Authentication (email/password) + Cloud Firestore, named database
  `talk-to-the-dead`.
- Data scoped per owning Firebase user: personas, memories, conversations.
- `pages/api/chat.ts`: verify user → load persona + memories → build system
  prompt → rate-limit → stream SSE reply → persist completed assistant reply.
- LLM behind the `lib/llm/` adapter (`lib/llm/index.ts` picks provider via
  `LLM_PROVIDER`).
- Server-side Firestore/Auth via REST (`lib/firestore.ts`,
  `lib/auth/firebase.server.ts`); client Firebase in `firebase/config.ts`.
- Rate limiting in `lib/rate-limit.ts` (in-memory fallback, or shared Upstash
  Redis when `UPSTASH_REDIS_REST_URL` is set — required for correct serverless
  behavior).

## The model / provider

- The **evaluation model is MiniMax M3** (per AGENTS.md). Do NOT spend persona
  work trying to make local models match MiniMax unless explicitly asked for an
  offline/privacy path.
- Local Gemma/Qwen were unsatisfactory for this product.
- Verify the active provider from environment config / AGENTS.md — do not assume
  a specific model; `README.md` may still describe older local defaults.

## Persona & prompt rules (critical)

- `lib/prompts.ts` builds the system prompt in explicit sections; behavioral
  patterns are HIGHEST PRIORITY.
- Model **behavior, not just phrases**: a pattern has trigger → emotion →
  typical reaction → characteristic phrase → natural follow-up. The phrase is
  evidence, not text to force verbatim.
- Do **not** frame the model as the real deceased person — it is a simulation
  based on supplied memories and behavioral evidence.
- Do **not** invent biographical facts, events, or memories. Ground strictly in
  supplied persona fields.
- Preserve the practical meaning/subtext of Hindi, Hinglish, and colloquial
  expressions rather than translating literally.
- Legacy personas using `oftenSaid: string[]` + free-text `traits` must keep
  working; treat legacy phrases as vocabulary evidence, never mandatory.
- Structured `speechExamples`: `context` (trigger), `phrase`, optional
  `meaning`, `tone`, `reaction`. `lib/firestore.ts` accepts legacy aliases
  (`trigger`→context, `emotion`→tone).
- Few-shot exemplars live under the behavioral section, capped at 3, built only
  from the person's own recorded fields.

## Known failure mode to avoid

The classic defect: model inserts the right phrase but follows it with a generic
response that misses the intended emotional reaction (e.g. says
`bill tumhara baap bharega` but then doesn't scold/question/continue in voice).
Always check: matching trigger → full emotional reaction + phrase used
naturally; non-trigger → phrase should NOT appear.

## Development guidance

- Inspect existing code before editing. Start with `components/PersonaSelection.tsx`,
  `lib/prompts.ts`, `lib/firestore.ts`, `pages/api/chat.ts`.
- Make the smallest coherent, incremental change. Do not rewrite Next.js,
  Firebase, the chat flow, or the LLM adapter for a persona feature.
- Preserve stored data and backward compatibility (`oftenSaid`, `traits`).
- Validate with the project's checks (see below) before broad follow-up.

## Commands / checks

Run these in the project directory:

- `npm test` — Vitest (not Jest). Single file: `npx vitest run <file>`.
- `npm run lint` — ESLint (next/core-web-vitals + next/typescript).
- `npx tsc --noEmit` — typecheck.
- `npm run build` — production build (Next.js 16, Turbopack).
- Dev: `npm run dev`.

## Testing the behavioral requirement

After a persona change, test BOTH a matching trigger and a non-trigger:
- Matching trigger (e.g. expensive purchase) should reproduce the emotional
  reaction pattern, using a characteristic phrase naturally.
- Ordinary update (e.g. coming home early) should NOT force the phrase.

The MiniMax cloud path may not be reachable from local dev; local LM Studio
models are NOT the evaluation target — treat local-model results as indicative
only.
