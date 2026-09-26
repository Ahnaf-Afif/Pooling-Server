# Authentication key rotation

This runbook separates authentication encryption/signing from stable vote
identifiers. It is not evidence that production keys have been rotated.

## Before deploying this change

1. Confirm a recent recoverable database backup and secured recovery access to
   Vercel, Atlas and Google. Never put secrets in chat, commits, logs or tickets.
2. For this existing installation, set server `VOTER_SECRET` to the exact
   `BETTER_AUTH_SECRET` that generated the existing vote receipts and guest
   cookies. Use the secret manager/Vercel environment editor without printing it.
   **Do not generate a new voter secret for an existing database.** For an empty
   installation, generate an independent random value of at least 32 characters.
3. Preserve `VOTER_SECRET` unchanged during authentication key rotations. The
   new server deliberately refuses production startup without it. Set it before
   deploying this release; it must never be a `NEXT_PUBLIC_` variable.
4. If the auth secret was already changed without preserving previous values,
   stop and investigate the historical voter keys. This release cannot recover
   lost HMAC keys or automatically reconnect those older receipts.
5. Apply and verify indexes using `npm run db:indexes -- --apply`, then
   `npm run db:indexes -- --verify` in the intended database environment.

## Rotate authentication encryption keys

Better Auth writes with the first versioned key and reads previous versions.
This project's `BETTER_AUTH_SECRETS` loader accepts a **JSON array**, not the
framework's alternative comma-separated environment format:

```text
[{"version":2,"value":"<new-random-secret>"},{"version":1,"value":"<previous-secret>"}]
```

The placeholders above are not usable credentials. Never reuse a version for a
different key. Keep the singular `BETTER_AUTH_SECRET` at its existing value while
legacy bare-hex encryption still needs that fallback.

1. Add the new version and retain previous versions. Keep `VOTER_SECRET` stable.
2. Deploy to an isolated staging environment first. Validate Google sign-in,
   magic links when configured, TOTP and a recovery code on a disposable account.
3. Deploy the key configuration to every serving production instance. Old
   deployments must no longer write ciphertext using a retired key; consider
   preview environments separately and never share their database with production.
4. Run `npm run db:rotate-auth` as a read-only preflight. It decrypts every stored
   OAuth token, TOTP secret and recovery-code payload but prints only counts.
   Undecryptable/plaintext data fails the preflight. Import known plaintext OAuth
   records with the separately reviewed `db:encrypt-oauth` migration first.
5. Run `npm run db:rotate-auth -- --apply`. A complete preflight precedes writes.
   Conditional updates prevent overwriting refreshed tokens, consumed recovery
   codes or replacement authenticators. A conflict fails the command; retain old
   keys and rerun. Partial progress is safe to rerun.
6. Run `npm run db:rotate-auth -- --verify`. This verifies decryption and that all
   covered persisted fields use the current version. Repeat after draining old
   deployments. A green check is **not** proof that old cookies or backups no
   longer require an old key.
7. Verify a controlled account's sign-in, existing votes, export, authenticator,
   and recovery behavior on the new deployment without making dummy public polls.

## Retiring old keys and incident response

- Wait for old signed cookies/links to expire, or explicitly revoke affected app
  sessions and require sign-in again. Normal sessions currently last up to 30
  days; account for every configured cookie/token lifetime and old deployment.
- Keep retired keys in a separately secured recovery archive while retained
  backups still contain ciphertext encrypted with those keys. Do not silently
  break restore capability. Do not leave compromised keys active just to preserve
  sessions; coordinate a forced sign-out during incident response.
- Rollback must retain every key version required by ciphertext already written.
  An old build with only the old key cannot read data encrypted by the new build.
- Encryption migration does not revoke Google's provider tokens or rotate the
  Google client secret. Revoke compromised/legacy app grants using Google's
  revocation process, then verify fresh consent/sign-in. This is a distinct,
  potentially disruptive owner-approved operation; do not infer completion from
  a ciphertext migration.
- `VOTER_SECRET` is a long-lived pseudonymization key, not an authentication key.
  If it is compromised, use a separately designed receipt/cookie migration; a
  blind environment-variable replacement would again disconnect old receipts.

References: [Better Auth versioned secrets](https://better-auth.com/docs/reference/options#secrets)
and [cookie rotation behavior](https://better-auth.com/docs/concepts/cookies).
