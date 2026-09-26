# What Do You Think? API

Express and MongoDB Atlas API for the What Do You Think? polling platform.

## Setup

```bash
npm install
cp .env.example .env
npm run dev
```

Set `MONGODB_URI` to an Atlas connection string and list allowed frontend origins in `CLIENT_ORIGINS`. Better Auth also needs a stable secret, the public frontend URL, and at least one configured sign-in provider. See `.env.example`.

Production also requires `VOTER_SECRET`. Before upgrading an existing database,
pin it to the previous auth secret used for voting; do not generate a replacement.
For a new empty database use an independent random secret. Follow
[SECRET-ROTATION.md](SECRET-ROTATION.md) before changing any production keys.

For Google, register these authorized redirect URIs:

```text
http://localhost:3000/api/auth/callback/google
https://pooling-client.vercel.app/api/auth/callback/google
```

For email magic links, verify a sending domain in Resend and set `RESEND_API_KEY` plus `AUTH_EMAIL_FROM`. `ADMIN_EMAILS` and `MODERATOR_EMAILS` bootstrap roles only when those accounts are first created. After that, administrators manage persistent roles from the website's user-management screen.

## Vercel

Vercel discovers `src/app.js` and uses its default Express app export. The separate `src/local.js` starts a listener only for local development.

Set all server variables from `.env.example` in the Vercel project's **Production** environment. Use `BETTER_AUTH_URL=https://pooling-client.vercel.app` and a unique random `BETTER_AUTH_SECRET` with at least 32 characters. Do not set `PORT` for the Vercel function. Redeploy after changing variables. The database connections are opened on demand and reused by warm function instances.

## API

- `GET /api/health` — readiness check
- `/api/auth/*` — Better Auth sign-in/session endpoints; built-in administration and alternative session-management routes are disabled
- `GET /api/auth-config` — enabled public sign-in methods (never returns credentials)
- `GET /api/polls?category=Tech&trending=true&page=1&limit=12` — filtered, paginated polls, `hasMore`, and platform statistics
- `GET /api/polls/:slug` — one poll
- `POST /api/polls` — create a poll (verified account required)
- `GET /api/polls/mine` — polls owned by the current account
- `PATCH /api/polls/:slug` — edit an owned poll before its first vote
- `POST /api/polls/:slug/close` — stop new votes
- `POST /api/polls/:slug/archive` — remove an owned poll from listings
- `DELETE /api/polls/:slug` — soft-delete an owned poll
- `POST /api/polls/:slug/votes` — record one vote per signed browser or account
- `POST /api/polls/:slug/reports` — submit a rate-limited public report
- `GET /api/moderation/reports` — role-protected report queue with internal action history
- `GET/PATCH /api/moderation/polls/:slug` — load or edit any poll with a required audit reason
- `POST /api/moderation/reports/:id/notes` — add a private moderation note
- `PATCH /api/moderation/reports/:id/poll` — edit reported content and resolve the report
- `POST /api/moderation/reports/:id/remove-poll` — soft-delete the poll and resolve the report
- `GET /api/moderation/users` — administrator-only, searchable account list
- `PATCH /api/moderation/users/:id/role` — assign a persistent user, moderator, or admin role
- `POST /api/moderation/users/:id/suspend` — suspend an account and revoke its sessions
- `GET /api/account/export` — download the signed-in account's data
- `POST /api/account/delete` — permanently delete the signed-in account after typed confirmation
- `POST /api/moderation/users/:id/reactivate` — restore a suspended account

Report decisions, content edits, role changes, suspensions, and reactivations are recorded in an internal audit history. Administrators cannot suspend themselves or change their own role through the dashboard, which prevents accidental lockout.

Writes use MongoDB-backed rate limits across Vercel instances. Poll creation is limited per account and IP. Anonymous voting uses a signed HttpOnly first-party cookie and a unique database receipt; it prevents repeat votes from the same browser but remains a casual-poll model because cookies, devices, and networks can be changed.

Run `npm run db:indexes` to inspect proposed indexes, then `npm run db:indexes -- --apply` in the intended environment before exposing features that depend on them. `npm run db:indexes -- --verify` checks required keys, uniqueness, partial filters and TTL settings without writing. Never point a test suite at Atlas. Run `npm run db:encrypt-oauth -- --apply` once after deploying Better Auth token encryption; both migration commands are dry-run by default. Better Auth's numeric rate-limit records are pruned opportunistically every hour on a warm API instance, while application rate buckets use a MongoDB TTL index.

## Staff security

Staff must enroll an authenticator from **Account → Account security**, save the recovery codes privately, and verify a code before accessing staff tools. Staff access requires a session created within 12 hours; moderation writes require factor verification within 15 minutes. Google sign-in alone does not meet this requirement. Ordinary login is not itself gated by the authenticator.

Account security lists signed-in devices without exposing session tokens. Revoking other devices and deleting an account require recent authentication (or recent factor verification when enabled). Staff cannot disable their authenticator. Select and test a second recovery administrator before launch; lost-factor recovery and recovery-code regeneration still need an operational workflow.

Suspending a poll owner revokes their sessions but deliberately leaves content reports pending. Staff must separately edit/remove the content or dismiss the report. Reports for content already removed can be resolved with an audit reason.

A poll is trending after at least three votes when its most recent vote was within seven days. Popular qualifying polls rank first, with recent activity breaking ties. Older records without an activity timestamp use their creation time during the transition.

## Checks

```bash
npm run lint
npm test
npm run test:integration
```

Use Node 22. Integration tests download MongoDB 7.0 into a temporary cache and create an isolated local replica set; they never reuse the application's database URI. Tests cover real auth enforcement, transaction rollback, duplicate-vote races, concurrent administrator safeguards, account deletion and index verification. Browser tests live in the frontend repository. See `PRODUCTION-READINESS.md` for outstanding requirements; passing these tests is not a production-readiness certification.
