# Release, rollback and outage checks

These checks do not make a build production-ready by themselves. In particular,
green local tests do not establish that the deployed environment is configured.

## Current voter-key incident

On September 27, 2026, public backend and proxied API requests returned 500,
including liveness. Production logs reported `VOTER_SECRET is required in
production`; the homepage itself still returned 200. No secret was printed or
changed during diagnosis.

Do not generate a new voter key for the existing database. Identify and privately
pin the historical key that generated its receipts, following SECRET-ROTATION.md.
If its history is uncertain, do not guess or rotate it. Confirm with the operator
and preserve the existing data while investigating.

## Before building

1. Record both repository commits, current deployment IDs, database migration
   state and a recoverable backup reference. Never record secrets in a ticket.
2. Use Node 22 and run both repositories' CI checks. Keep staging credentials and
   databases separate from production; never run test fixtures against Atlas.
3. Verify target environment variables privately. Production requires an
   explicit MongoDB database, non-placeholder auth and voter keys, an HTTPS
   frontend origin in both `BETTER_AUTH_URL` and `CLIENT_ORIGINS`, and at least
   one complete provider. Production origins may not contain paths or trailing
   slashes. Remove development origins from the production list.
4. Run `npm run check:production` with the intended variables already in the
   process environment. It does NOT automatically load `.env`. For an explicitly
   chosen local file use `node --env-file=/secure/path/release.env
   scripts/check-production.js`. Keep that file outside tracked/uploaded paths.
5. Run `npm run db:indexes -- --verify` against the intended database. If it fails,
   review the migration and backup first; apply only the approved migration, then
   verify again. Build and smoke checks do not create/verify database indexes.
   The current release requires `2026-09-command-retries-v7`, including its
   command-receipt lookup/TTL indexes and all previous required indexes.

`vercel.json` runs the same configuration/entrypoint check during the backend
build, before runtime traffic. It does not contact MongoDB or send email and cannot
prove credentials, historical voter-key compatibility or Google consent settings.
The runtime validates the same configuration. The gate applies to preview builds
too: configure their isolated environment instead of bypassing the checks.
Keep build and runtime variables consistent; a build-only variable does not fix
a missing runtime secret. The deployed smoke check remains necessary.

## Candidate and promotion

1. Confirm both Vercel projects, environment and matching frontend/backend commits.
   Cursor contracts changed; do not pair older numbered-page clients with this API.
   The new browser also requires command replay acknowledgements for creation
   and moderation; promote it only with the matching command-enabled backend.
2. Disable automatic domain assignment in the approved release setup. Vercel's
   `vercel deploy --prod --skip-domain` creates a production candidate without
   moving its production domains. This still uses production credentials: no
   synthetic users, polls, reports or votes may be created there.
3. Check the candidate's build/runtime logs for initialization failures, and test
   the isolated staging pair with real browser auth and owner/staff flows first.
   A frontend candidate must point to its intended backend. OAuth callback hosts
   and deployment protection must be configured; do not silently disable them.
4. Run the read-only smoke command against the intended pair:

   ```bash
   npm run check:release -- --api https://pooling-server.vercel.app --site https://pooling-client.vercel.app
   ```

   Substitute candidate origins when testing candidates. It checks direct and
   proxied liveness, database health, available sign-in configuration, cursor-feed
   shape, homepage and security headers. Every request is GET, bounded by ten
   seconds, with no cookies or credentials. Redirects, protection/login pages,
   invalid JSON, missing providers and non-200 responses fail. Protected
   candidates require an approved separate authenticated check; do not weaken
   deployment protection just to make this unauthenticated command pass.
5. After the operator's approval, promote the verified compatible pair and rerun
   smoke checks on production aliases. Confirm Google sign-in, sessions and staff
   step-up with an authorized real account without creating dummy public posts.

Vercel's build gate is implemented in this repository. The public smoke workflow
runs every 15 minutes and manually once committed to the remote default branch.
Neither is an automatic, atomic two-project promotion gate. GitHub required
checks, Vercel auto-assignment settings, production approvals, workflow alert
recipients and staging still need operator configuration and verification.
GitHub schedule timing is best-effort; this is not a guaranteed uptime service.

## Outage and rollback

1. Check both liveness and readiness directly and through the frontend. A 200
   homepage is insufficient. Capture request IDs and sanitized errors, not tokens.
2. Liveness failure suggests initialization/platform failure; inspect runtime logs
   and target variables before changing Atlas network access. Readiness alone
   failing suggests checking database availability/permissions and pool pressure.
3. For a missing variable, restore its known intended value and deploy a checked
   candidate. Never replace unknown historical keys opportunistically.
4. If rolling back, choose the recorded compatible frontend/backend pair. Retain
   every encryption key version needed by already-written ciphertext. Older code
   may not understand new indexes/data/contracts; never reverse migrations or
   restore a database merely to silence a deployment error.
5. If no compatible rollback exists, use a maintenance response while preparing a
   forward fix. The operator must authorize any data restore after assessing votes
   and other changes made since the backup. A backup restore drill remains required.
6. Repeat public smoke checks and authorized sign-in checks after recovery; record
   incident times, cause, affected features and corrective follow-up.

References: [Vercel build configuration](https://vercel.com/docs/project-configuration/vercel-json#buildcommand)
and [unpromoted production deployments](https://vercel.com/docs/cli/deploy#skip-domain).
