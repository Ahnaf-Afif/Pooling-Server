# Production readiness work ledger

Source: the full audit supplied in `goal-objective.md`. Completion is still
unproven. A successful build and mocked route tests do not prove all items below.
No production test may create dummy public posts or change real user data.

| Requirement | Current evidence / remaining work |
| --- | --- |
| OAuth encryption, token migration and rotation | Versioned encryption configured; guarded rotation command covers OAuth/TOTP/recovery ciphertext, preflights decryption and protects concurrent updates. Local migration/retirement tests pass. See SECRET-ROTATION.md; actual production key rotation and provider-token revocation remain unverified. |
| Restrict privileged auth paths | Admin and alternative session-management paths disabled; actual-handler and authenticated integration tests pass. Keep denylist reviewed on auth upgrades. |
| Staff MFA, step-up, shorter sessions | TOTP/recovery enrollment and session-scoped proof implemented; 15-minute write step-up and 12-hour staff access gate tested on Node 22. Google login itself is not MFA-gated; recovery/admin enrollment deployment still pending. |
| Recovery administrator | Requires a second account selected by the owner; do not invent one. |
| User session list and revocation | Token-free session list and guarded revocation implemented. Recovery-code replacement now requires session-scoped step-up, revokes other sessions, consumes its proof and rejects concurrent replacements. Lost-factor requests require fresh sign-in and another independently verifying MFA-enabled administrator; resets/session revocation/audit commit together. TTL/cancellation, retry safety, encrypted codes and privacy cleanup are integration-tested. See STAFF-RECOVERY.md. Backup-admin enrollment, all-admin lockout procedure and automated notifications remain. |
| Atomic voting, concurrency and retry safety | Real replica-set tests prove duplicate-vote concurrency, rollback and successful same-choice retries without recounting or updating activity; conflicting choices remain rejected, closed polls allow successful replays and deleted polls remain unavailable. Stable VOTER_SECRET preserves identities across auth-key changes. Private my-vote lookup establishes guest cookies before submission and scopes results to the current identity. Anonymous/account reconciliation remains; browser-clearing cannot prove one-human/one-vote. |
| Atomic moderation, admin safeguards and idempotency | Real rollback and concurrent last-admin tests pass. Owner suspension keeps reports pending; removed-content resolution and no-op status retries fixed. General command idempotency and role-bootstrap lifecycle remain. |
| Index migration, verification, versioning | Required-index verifier and migration marker implemented; test detects dropped index and repairs it. Recovery adds migration 2026-09-account-recovery-v5 (including existing declarations), unique request references and 24-hour request TTL. Target production migration/verification still required. |
| Semantic vote integrity and edit history | Server locks labels/question after votes; UI now disables these fields, snapshots/notices exist. Full history, browser/concurrency coverage and deployed checks remain. |
| Runtime, test timeouts, CI and dependency maintenance | Official checksum-verified Node 22.23.3: 47 unit tests and 32 isolated integration tests pass. Syntax checking covers all JS files. Latest recovery Turbopack build passes; both engines passed at an earlier checkpoint. CI deployment gating and automated dependency updates remain. |
| Abuse protection | IP write limits exist. Need account-aware/read controls and bot mitigation; anonymous voting cannot prove one human/one vote. |
| Feed performance | Public/owner cursor pagination, matching ordered indexes, shared 60-second statistics cache/refresh lease, constant categories and corrected active count implemented. Node 22 replica-set tests cover ties, new inserts, legacy activity dates and query plans on 1,000 local test polls. Broader load/capacity tests, trending scan analysis, redundant-index cleanup and deployed verification remain. |
| Connection pooling and geography | Shared pool exists. Measure placement; Atlas region/settings need verification. |
| Data visibility | Owner/report pagination exists; deep page caps and truncated histories still hide older data. |
| Moderation workflow | Need assignment, priority, escalation, notifications/outcomes, appeals, and durable audit strategy. |
| Account privacy | Audit attribution and both string/ObjectId provider links fixed and integration-tested. Export/deletion still find old receipts when auth keys change with pinned VOTER_SECRET. Export now requires recent sign-in or session-scoped MFA, tested against stale/other-device sessions. Retained free text/snapshots, provider revocation, deletion/create races and scalable export/deletion remain. |
| Retention and policy | Need executable retention, precise periods, terms acceptance, operator/age/jurisdiction details from owner. |
| Browser security and search | Headers, self-hosted fonts, robots and sitemap exist; verify deployed behavior and CSP coverage. |
| Rendering and live results | SSR poll content is verified in returned h1 HTML using a read-only local API fixture. Browser tests cover 10-second refresh, retaining results through an outage, recovery and hidden-tab suppression. Deployed verification and load measurements remain. |
| Frontend quality | Sixteen Chromium tests pass on the standalone Turbopack production bundle: security/pagination/voting regressions plus recovery-code replacement, lost-factor request/cancellation and independently confirmed admin approval. Need whole-site accessibility, performance, real frontend/backend flow and cross-browser coverage. |
| Release/source consistency | Local commits ahead of remotes. Verify/push tested commits and prevent production drift. |
| Operations | Need staging/isolated integration, release/rollback/incident/restore runbooks, metrics and alert verification. |
| External controls | Atlas backup/restore, access list, alerts/region; Vercel WAF/spend/protection; OAuth publishing/quotas; monitored support and recovery access remain unverified. |

Owner input requested: public operator name, country/jurisdiction, support mailbox,
minimum age and recovery administrator email. No credentials requested in chat.
Additional optional choice requested: ask before associating a guest vote with a
signed-in account, or link automatically. No guest/account linking is implemented
by this checkpoint; the privacy-sensitive choice has not been silently assumed.

## Recovery checkpoint (September 27, 2026)

- Previous goal turn classified as progress: committed voting/retry/private-lookup changes. This turn adds working recovery features; the full production objective remains incomplete.
- Official Node 22.23.3 archive checksum verified again. Backend syntax, 47 unit tests, and 32 local replica-set integration tests pass. New tests prove encrypted/single-use replacement codes, simultaneous replacement/approval behavior, audit/session rollback, self/moderator/stale-proof rejection, expiry/cancellation, changed-factor protection, cursor pagination and export/deletion cleanup.
- Temporary test database only; the suite does not load project env files or connect to Atlas. Injected audit/cancellation failures are intentional rollback tests.
- Production frontend build and lint pass. Sixteen fixture-backed Chromium tests pass against the actual standalone bundle. The new admin test initially stopped at the working MFA gate; it was corrected to perform verification before testing approval. No application security gate was weakened to pass it. No live provider or production deployment verification is implied.
- Recovery UI and backend must be promoted together after applying/verifying `2026-09-account-recovery-v5`. Do not promote until the historical VOTER_SECRET prerequisite is satisfied. No secrets, production accounts, deployments or remotes changed.
- Operator input still required: select and test a second secured administrator. Recovery requests currently require contacting a known administrator separately; automated notifications and an owner-approved all-admin-lockout procedure remain outstanding.

## Previous voting verification (September 27, 2026)

- Previous goal turn: progress via local checkpoints 6a4d2d5 (backend) and 227a085 (frontend), with Node 22 unit/integration and standalone Chromium evidence.
- Current changes remain local; no production deployment is claimed.
- Restricted listeners initially returned EPERM. Approved execution restored real HTTP test coverage; the previous approval-review availability issue is no longer blocking these backend checks.
- Node 22.23.3 unit suite: 47/47 passing. Local MongoDB 7.0 replica-set suite: 24/24 passing, adding private vote lookup, guest preparation, same-choice retry and conflicting-choice concurrency regressions. No Atlas data used.
- Frontend lint and default Turbopack production build pass on Node 22 in a temporary copy excluding environment files. Thirteen fixture-backed Chromium tests pass against the actual standalone launcher including static assets. The read-only SSR fixture runs only on localhost:5199; no test posts reach a real deployment. This is not a live OAuth/Atlas deployment test; the previous webpack build evidence predates the latest changes.
- A query-plan regression initially examined 139 documents for 11 later-page results. A leading-key cursor bound now keeps the tested public/category/owner queries under 40 examined documents and avoids blocking sorts. This is bounded local evidence, not a production load benchmark.
- Cursor API changes require a coordinated frontend/backend promotion and migration 2026-09-poll-cursors-v4. Numbered moderation lists, truncated history, sitemap's 10,000-poll ceiling and homepage's first-page-only ownership badges remain open.
- Pagination/statistics checkpoints saved locally as server 65094af and client 3fc37b3. The following security checkpoint rejects external/backslash/dot-segment return paths and requires fresh verification for exports. No pushes or deployments performed.
- The current voting checkpoint also requires the matching backend my-vote endpoint before frontend promotion. Legacy localStorage vote markers are removed on poll/results views; database receipts are preserved. Guest/account identity reconciliation and general poll-creation/moderation command idempotency remain separate work.

Deployment prerequisite for this backend checkpoint: set VOTER_SECRET to the
historical auth key used to generate existing receipts before deploying. Do not
push into an automatic production deployment until that value is pinned and the
target environment is verified. No production secrets were changed this turn.
