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
| User session list and revocation | Token-free session list and guarded revocation implemented and integration-tested. Full recovery-code regeneration and lost-factor recovery remain. |
| Atomic voting, concurrency and retry safety | Real replica-set tests prove duplicate-vote concurrency and rollback. Stable VOTER_SECRET preserves existing identities across auth-key changes; production must pin the legacy value before deployment. Anonymous/account reconciliation and retry-result handling remain. |
| Atomic moderation, admin safeguards and idempotency | Real rollback and concurrent last-admin tests pass. Owner suspension keeps reports pending; removed-content resolution and no-op status retries fixed. General command idempotency and role-bootstrap lifecycle remain. |
| Index migration, verification, versioning | Required-index verifier and migration marker implemented; test detects dropped index and repairs it. Target production migration/verification still required. |
| Semantic vote integrity and edit history | Server locks labels/question after votes; UI now disables these fields, snapshots/notices exist. Full history, browser/concurrency coverage and deployed checks remain. |
| Runtime, test timeouts, CI and dependency maintenance | Official checksum-verified Node 22.23.3: 46 unit tests and 16 isolated integration tests pass. Syntax checking covers all JS files. Both frontend build engines passed at the frontend checkpoint. CI deployment gating and automated dependency updates remain. |
| Abuse protection | IP write limits exist. Need account-aware/read controls and bot mitigation; anonymous voting cannot prove one human/one vote. |
| Feed performance | Still performs aggregate/distinct/count per page and uses offsets. Implement cursors, reusable statistics and correct active count. |
| Connection pooling and geography | Shared pool exists. Measure placement; Atlas region/settings need verification. |
| Data visibility | Owner/report pagination exists; deep page caps and truncated histories still hide older data. |
| Moderation workflow | Need assignment, priority, escalation, notifications/outcomes, appeals, and durable audit strategy. |
| Account privacy | Audit attribution and both string/ObjectId provider links fixed and integration-tested. Export/deletion still find old receipts when auth keys change with pinned VOTER_SECRET. Retained free text/snapshots, provider revocation and scalable export/deletion remain. |
| Retention and policy | Need executable retention, precise periods, terms acceptance, operator/age/jurisdiction details from owner. |
| Browser security and search | Headers, self-hosted fonts, robots and sitemap exist; verify deployed behavior and CSP coverage. |
| Rendering and live results | Initial poll/results server rendering and visible-tab result refresh implemented locally; production compilation passes. Poll-rendering/live-refresh browser coverage and deployed verification remain. |
| Frontend quality | Four Chromium tests pass against both production build engines: sign-in outage/retry, staff enrollment/access, scoped security accessibility, signed-out account gate. Need whole-site accessibility, performance, real frontend/backend flow and cross-browser coverage. |
| Release/source consistency | Local commits ahead of remotes. Verify/push tested commits and prevent production drift. |
| Operations | Need staging/isolated integration, release/rollback/incident/restore runbooks, metrics and alert verification. |
| External controls | Atlas backup/restore, access list, alerts/region; Vercel WAF/spend/protection; OAuth publishing/quotas; monitored support and recovery access remain unverified. |

Owner input requested: public operator name, country/jurisdiction, support mailbox,
minimum age and recovery administrator email. No credentials requested in chat.

## Latest verification (September 26, 2026)

- Previous goal turn: progress via local checkpoints 727fe2b (backend) and ae24192 (frontend), with real Node 22 unit/integration and Chromium evidence.
- Current changes remain local; no production deployment is claimed.
- Restricted listeners initially returned EPERM. Approved execution restored real HTTP test coverage; the previous approval-review availability issue is no longer blocking these backend checks.
- Node 22 unit suite: 46/46 passing. Local MongoDB 7.0 replica-set suite: 16/16 passing, including auth, transactions, account deletion, index drift/repair, stable voter-key behavior and guarded ciphertext rotation. No Atlas data used.
- Frontend lint passes; webpack and default Turbopack production builds pass on Node 22 in a temporary copy excluding environment files. Four mocked-API Chromium tests pass against each build. This is not a live OAuth/Atlas deployment test. The browser runner currently uses `next start`, which warns when standalone output is enabled; switch to the standalone launcher before claiming standalone packaging coverage.

Deployment prerequisite for this backend checkpoint: set VOTER_SECRET to the
historical auth key used to generate existing receipts before deploying. Do not
push into an automatic production deployment until that value is pinned and the
target environment is verified. No production secrets were changed this turn.
