# Shazam Backend (Videofy API)

Standalone Express 5 + TypeScript API server: Gemini Vision identification, Firebase auth, Stripe subscriptions, PostgreSQL history.

## Setup

```bash
npm install
cp .env.example .env   # fill in DATABASE_URL, Firebase, Gemini, Stripe keys
npm run db:push        # create database tables
npm run dev            # http://localhost:8080
```

## Scripts

- `npm run dev` — dev server with hot reload (tsx watch)
- `npm run build` — bundle to `dist/` with esbuild
- `npm start` — run the production bundle
- `npm run typecheck` — TypeScript check
- `npm run db:push` — push Drizzle schema to Postgres

## Structure

- `src/routes/` — identify (Gemini), history, users, stripe, health
- `src/middlewares/` — Firebase auth (`requireAuth`, `requirePayment`)
- `src/lib/firebaseAdmin.ts` — Firebase Admin SDK init
- `src/db/` — Drizzle ORM schema + client (formerly `@workspace/db`)
- `src/schemas/` — Zod request/response validation (formerly `@workspace/api-zod`)
- `src/gemini/` — Gemini AI client (formerly `@workspace/integrations-gemini-ai`)
