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

The backend build now runs `npm run check:production` through `vercel.json`.
It fails before release if required production configuration or the real Express
entrypoint is invalid. It reads the supplied environment, not `.env`; production
`CLIENT_ORIGINS` must explicitly list HTTPS origins and include `BETTER_AUTH_URL`.
Google-only operation does not require Resend. Never replace an existing auth or
voter key with a new random value during an upgrade. See [RELEASE.md](RELEASE.md)
for staged promotion, read-only smoke checks, outage response and rollback limits.

## API

- `GET /api/health` — readiness check
- `/api/auth/*` — Better Auth sign-in/session endpoints; built-in administration and alternative session-management routes are disabled
- `GET /api/auth-config` — enabled public sign-in methods (never returns credentials)
- `GET /api/polls?category=Tech&trending=true&limit=12` — filtered polls, `hasMore`, `nextCursor`, and cached platform statistics
- `GET /api/polls/:slug` — one poll
- `POST /api/polls` — create a poll (verified account required)
- `GET /api/polls/mine` — polls owned by the current account
- `PATCH /api/polls/:slug` — edit an owned poll before its first vote, with `expectedRevision`
- `POST /api/polls/:slug/close` — stop new votes
- `POST /api/polls/:slug/archive` — remove an owned poll from listings
- `DELETE /api/polls/:slug` — soft-delete an owned poll
- `GET /api/polls/:slug/my-vote` — private current-account/guest receipt lookup; establishes a signed guest cookie before voting
- `POST /api/polls/:slug/votes` — record one vote per signed browser or account; identical retries return success without recounting
- `POST /api/polls/:slug/reports` — submit a rate-limited public report
- `GET /api/moderation/reports` — role-protected, cursor-paginated report queue
- `GET /api/moderation/reports/:id/history` — full retained report history, cursor-paginated
- `GET /api/moderation/polls/:slug/history` — full retained poll history, including removed polls
- `GET /api/moderation/users/:id/history` — administrator-only account action history
- `GET /api/moderation/history` — administrator-only retained audit log, including anonymized actions
- `GET/PATCH /api/moderation/polls/:slug` — load or edit any poll with a required audit reason and `expectedRevision`
- `POST /api/moderation/reports/:id/notes` — add a private moderation note
- `PATCH /api/moderation/reports/:id/poll` — edit reported content and resolve the report, with `expectedRevision`
- `POST /api/moderation/reports/:id/remove-poll` — soft-delete the poll and resolve the report
- `GET /api/moderation/users` — administrator-only, searchable account list
- `PATCH /api/moderation/users/:id/role` — assign a persistent user, moderator, or admin role
- `POST /api/moderation/users/:id/suspend` — suspend an account and revoke its sessions
- `GET /api/account/export` — download account data after recent sign-in or authenticator verification
- `POST /api/account/delete` — permanently delete the signed-in account after typed confirmation
- `POST /api/moderation/users/:id/reactivate` — restore a suspended account

Report decisions, content edits, role changes, suspensions, and reactivations are recorded in an internal audit history. Administrators cannot suspend themselves or change their own role through the dashboard, which prevents accidental lockout.

Every poll content response includes `contentRevision` (starting at zero). Send
that number as `expectedRevision` for any owner or staff content edit. A stale
edit returns HTTP 409 with `code: "POLL_CHANGED"`; it does not overwrite content
or resolve reports. Reload the poll and review the latest content before trying
again. Existing documents without a revision are treated as revision zero and
gain revision one on their first guarded edit. Deploy the frontend and backend
edit contract together; older clients that omit the revision receive HTTP 400.

### Poll pagination and statistics

Public and owned poll lists use opaque `nextCursor` values. Pass the returned
cursor as `cursor` with the same filters to load the next page; a null cursor
means the end. Public limits are 1–100 (default 50); owner limits are 1–50
(default 24). Changed filters or accounts require restarting without a cursor.
Numbered pages after page one are rejected.

### Staff lists and audit history

Reports and user lists also use `nextCursor`/`cursor`, with no fixed last-page
cutoff. Defaults are 25 reports and 20 users per page; `limit` accepts 1–50.
User search keeps `q` and `field` unchanged across pages. Cursors are bound to
the list and its filters; reset them when changing report status or search.
These lists do not return expensive exact totals or embed history arrays.

History endpoints return `{ actions, nextCursor }` with 25 actions by default
(maximum 50). All retained records can be traversed newest first with an
immutable ID tie-breaker. Before/after snapshots remain available. History is
loaded on demand in the UI instead of inflating every queue response. Refresh
to see newly added actions; status changes/deletion can remove rows between
requests. This is live pagination, not an immutable exported snapshot.

Account IDs retain their BSON string/ObjectId type across cursor boundaries.
Private response caching is disabled. Moderators can read report/poll history;
account history and the global log require an administrator. Audit subjects may
be removed without hiding their retained records from the global log. Account
deletion still anonymizes links according to the account-deletion workflow.
Append-only external retention and final retention policy remain separate work.

Public statistics are global, not category-specific. They refresh at most once
per minute through a shared database lease, and only accompany the first page
unless `stats=false` is supplied. `stats: null` means temporarily unavailable;
`stats.stale: true` identifies a previously cached value during a refresh or
outage. Categories come from the fixed category list; active count excludes
closed and archived polls. Later pages omit statistics.

Newest-first cursors use creation time and an immutable ID tie-breaker. Trending
uses live vote/activity ordering, not a frozen snapshot: changed ranks can move
a poll before a previous cursor, so refresh to see the current ordering.

**Release compatibility:** deploy the matching frontend and backend together
behind a verified release process. An older frontend's `page=2` requests will
fail against this API; an older backend does not provide the new cursors. Apply
and verify migration `2026-09-command-retries-v7` before promotion, and preserve the
VOTER_SECRET prerequisite documented in SECRET-ROTATION.md. No production
migration or deployment is implied by the local tests.

Writes use MongoDB-backed rate limits across Vercel instances. Poll creation is limited per account and IP. Anonymous voting uses a signed HttpOnly first-party cookie and a unique database receipt; it prevents repeat votes from the same browser but remains a casual-poll model because cookies, devices, and networks can be changed.

### Request protection

The default limits below count attempts in fixed UTC-aligned windows, not rolling
periods. Rejected/invalid attempts may consume an earlier network bucket. Limits
are centralized in `src/rate-limit.js`; tune them using actual traffic and shared
network measurements before expanding the audience.

| Request group | Identity allowance | Network backstop |
| --- | --- | --- |
| API GET/HEAD | — | 600/minute |
| API POST/PATCH/PUT/DELETE | Additional limits below | 300/minute, before authentication/body parsing |
| Account, owner-list and staff reads | 120/account/minute | API read backstop |
| Voting and other general application writes | 30/account or signed guest/minute | API write backstop |
| Poll creation | 10/account/day | 100/day |
| Reports | 5/account or signed guest/hour | 50/hour |
| Account export | 3/account/hour | 30/hour |
| Authenticator/recovery attempts | 10/account/15 minutes | 100/15 minutes |

Better Auth retains its own additional authentication limits. Liveness is a cheap,
database-independent route and bypasses these database-backed limits; readiness
does not. Browsing and voting still do not require an account. Guest quotas use
the existing signed first-party voter cookie, and a first vote creates only one
identity shared by its limiter and receipt. Authenticated public writes resolve
the real session before applying the participant allowance, so changing IPs does
not reset the account quota. Different users on a shared IP get separate smaller
allowances, subject to the larger shared network cap.

Counters use atomic MongoDB increments and the existing rate-bucket TTL index.
Each limiter instance caches at most 5,000 rejected bucket keys until their window
ends. This avoids repeated counter writes for a known rejection without ever
caching permission to proceed. Cold starts and cache eviction still consult
MongoDB; they do not reset the shared allowance. Database errors fail closed with
503 instead of allowing an unprotected operation. Responses use private/no-store
and Retry-After for 429/503 protection failures. A new policy/key format can start
fresh rate buckets on release; it does not change vote identities or receipts.

This is application-level protection, not a DDoS or one-human/one-vote guarantee.
Fixed-window boundaries permit bursts; cycling cookies/accounts/IPs remains
possible. Network limits can still affect busy shared networks. Verify real client
IP attribution on both Vercel paths (including forwarded-header spoofing and IPv6
address rotation) before relying on network quotas. New identities and cold
instances still cause database work, and authentication may run before some
identity-specific limits. Edge/WAF controls, bot-provider approval, realistic
load measurements and rate-limit alerting remain separate release requirements.

Voting clients should load `my-vote` and preserve its cookie before the first
submission. Its response contains only `optionId` (or null), uses `private,
no-store`, and does not accept a caller-supplied account ID. A signed-in request
reads only that account's receipt, not a previous guest's choice on the device.
`POST /votes` returns `{ poll, replayed }`; retrying the same choice returns
`replayed: true` without changing totals or activity timestamps, even if the poll
has since closed. A different choice returns 409; deleted polls return 404.
Guests who discard cookies and anonymous-to-account duplicate identities remain
limitations pending reconciliation. This does not claim one-human/one-vote.

Run `npm run db:indexes` to inspect proposed indexes, then `npm run db:indexes -- --apply` in the intended environment before exposing features that depend on them. `npm run db:indexes -- --verify` checks required keys, uniqueness, partial filters and TTL settings without writing. Never point a test suite at Atlas. Run `npm run db:encrypt-oauth -- --apply` once after deploying Better Auth token encryption; both migration commands are dry-run by default. Better Auth's numeric rate-limit records are pruned opportunistically every hour on a warm API instance, while application rate buckets use a MongoDB TTL index.

## Staff security

Staff must enroll an authenticator from **Account → Account security**, save the recovery codes privately, and verify a code before accessing staff tools. Staff access requires a session created within 12 hours; moderation writes require factor verification within 15 minutes. Google sign-in alone does not meet this requirement. Ordinary login is not itself gated by the authenticator.

Account security lists signed-in devices without exposing session tokens. Revoking other devices and deleting an account require recent authentication (or recent factor verification when enabled). Staff cannot disable their authenticator. Recovery codes can be replaced after verification, invalidating old codes and revoking other sessions. Lost-factor recovery requires a fresh sign-in and independent approval by another MFA-verified administrator; it is transactional and audited. See [STAFF-RECOVERY.md](STAFF-RECOVERY.md). Select and test a second recovery administrator before launch. Recovery notifications are currently manual.

The current index migration includes the recovery indexes introduced in `2026-09-account-recovery-v5`. Request records expire after 24 hours. Apply and verify indexes before promoting this backend and its matching account/admin UI.

Deleting, demoting or suspending an active administrator requires a different
active administrator with verified email, completed MFA enrollment and a stored
authenticator record. The check excludes the departing account and coordinates
with concurrent role, deletion and recovery operations. It cannot prove that a
person still controls their provider account or device; test backup access before
relying on it. An administrator role without enrollment is not a usable backup.

Suspending a poll owner revokes their sessions but deliberately leaves content reports pending. Staff must separately edit/remove the content or dismiss the report. Reports for content already removed can be resolved with an audit reason.

### Concurrent account changes

Application-owned authenticated writes recheck the stored account and session
inside their database transaction. They update an internal revision on both
records, coordinating poll creation/owner changes, signed-in votes/reports,
moderation actions, account deletion, session revocation and recovery operations.
If deletion or revocation wins, the old request is rejected; if an app write
wins, deletion retries and removes/anonymizes its new links. Moderation also
rechecks current role, staff-session age and MFA proof inside the transaction,
and records the current stored actor rather than the earlier middleware snapshot.

This coordination is per account/session, not a global vote lock. Administrator
changes retain the shared last-admin guard. Failed transactions roll back the
internal revisions as well as their business changes. These extra database
operations and contention still need production capacity measurement.

Guest voting remains public and uses its separate signed-cookie receipt; a
rejected signed-in write does not silently switch to a guest within the same
request. Signing out can still enable a separate anonymous vote. Better Auth's
own OAuth/session creation and authenticator enable/verify/disable flows are not
made transactionally atomic by this guard; their deletion/concurrency boundaries
remain separate work. Scalable account cleanup and retained free-text privacy
also remain open.

### Command retries

Poll creation and custom moderation mutations accept an `Idempotency-Key` of
20–128 letters, numbers, hyphens or underscores. Reuse the same key and JSON
payload to retry an uncertain result within 24 hours. Keys are scoped to the
authenticated account, method, route and parameters. Changed data returns 409;
object field ordering does not matter. A receipt and its business/audit writes
commit in one transaction. Replays still require current session, role and MFA
authority; they never reapply an old decision over newer changes. Responses have
`Idempotency-Replayed: true` or `false`. Returned entities reflect current state;
removed targets return 404 rather than being recreated. Receipts store only
references/counts and a keyed request fingerprint, not request/response copies.

The matching frontend sends keys automatically and checks the acknowledgement
and response shape. Its `X-Command-Actor` header rejects an account switch between
preparation and submission. Legacy callers without keys remain supported, but
do not get command replay protection. Owner edit/close/archive/delete and reports
do not yet use this protocol; voting and recovery approval have their own retry
semantics. Rate limits count attempts, including replays. A key reused after
expiry can execute again; never treat it as permanent duplicate protection.

The browser keeps up to 32 pending request digests/keys/timestamps in tab-scoped
session storage, not raw content, account IDs or tokens. Failure retains the key;
confirmed success clears it. Reloading and re-entering identical data in the same
tab resumes it. The browser stops retries after 23 hours, on clock rollback, or
when tracking storage is unavailable/corrupt/full. Check My Polls or staff history
before starting a new request in a new tab. Closing the tab, clearing storage or
changing the payload can create a new intent; this is not cross-device deduplication.
No automatic write retries occur. Account deletion clears authored receipts and
removes deleted account references from other receipts. Export exposes only the
operation and timestamps. Migration v7 adds receipt expiry/lookup indexes.

A poll is trending after at least three votes when its most recent vote was within seven days. Popular qualifying polls rank first, with recent activity breaking ties. Older records without an activity timestamp use their creation time during the transition.

## Checks

```bash
npm run lint
npm test
npm run test:integration
```

Use Node 22. Integration tests download MongoDB 7.0 into a temporary cache and create an isolated local replica set; they never reuse the application's database URI. Tests cover real auth enforcement, transaction rollback, duplicate-vote races, concurrent administrator safeguards, account deletion and index verification. Browser tests live in the frontend repository. See `PRODUCTION-READINESS.md` for outstanding requirements; passing these tests is not a production-readiness certification.
