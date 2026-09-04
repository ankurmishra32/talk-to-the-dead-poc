# Talk to the Dead — PoC

> Inspired by *Black Mirror* S02E01 "Be Right Back" — an AI simulation of someone you remember, built from your memories of them.

A Next.js app that lets you hold a conversation with an AI persona of someone who has passed. You describe the person — who they were, how they spoke, what they often said — and the model responds in their voice, drawing on memories you've saved. No audio recordings or data uploads required; just your memory.

This is a **proof of concept** exploring the experience and underlying plumbing (auth, data model, local LLM streaming, security) before committing to a larger architecture.

## Documentation

- **[`prd.md`](./prd.md)** — Product Requirements: vision, user journey, features, persona & behavioral design, data model (product view), non-functional requirements, roadmap, known gaps.
- **[`architecture.md`](./architecture.md)** — Technical architecture: stack, request lifecycle, component map, data schemas, LLM / auth / Firestore layers, SSE protocol, persistence, security, env vars, commands.

## Quick start

```bash
npm install
cp .env.example .env.local
# fill in the Firebase + LLM values (see architecture.md §14 for the full table)
npm run dev                 # http://localhost:3000
```

Prerequisites: Node (per Next.js 16), a running local LLM (LM Studio or Ollama), and a Firebase project with email/password auth, Firestore, and a named database `talk-to-the-dead`.

> **Firebase API key — what it is and isn't.** The key in `firebase/config.ts` is
> a Firebase **browser** key. It is public by design: the JS bundle ships it to
> every visitor, so it is commit-safe and not a secret. The server half reads
> its own `FIREBASE_API_KEY` from env. What actually protects your project is
> (1) deploying the Firestore security rules below, and (2) **restricting the key
> by HTTP referrer** in Google Cloud Console → APIs & Services → Credentials:
> allow `http://localhost:3000/*` and your production domain(s), and restrict
> the key to the Identity Toolkit and Cloud Firestore APIs. This is a one-time
> manual step — there's nothing to commit.

> **Before using real data, deploy the Firestore security rules:**
> ```bash
> firebase use --add
> firebase deploy --only firestore:rules
> ```
> Without them the database is world-readable and world-writeable.

## Commands

```bash
npm run dev      # Dev server with Turbopack
npm run build    # Production build
npm start        # Serve production build
npm run lint     # ESLint (next/core-web-vitals + next/typescript)
```

## License

Licensed under [GNU Affero General Public License v3.0](LICENSE).

In short: you're free to use, modify, and distribute this code, including commercially. If you run a modified version as a network service, you must make your source available to its users under the same license.
