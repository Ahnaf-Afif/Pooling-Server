# Account and staff recovery

This workflow does not bypass Google/email ownership or create a recovery admin.
Choose a second trusted administrator, enroll and verify their authenticator,
save their recovery codes offline, and test both accounts before launch. Keep
Vercel, Atlas, Google and the support mailbox recoverable separately.

## Replace recovery codes while you still have a factor

1. Open Account → Account security and verify an authenticator or unused code.
2. Choose **Replace recovery codes** and confirm the session revocation.
3. Store the ten newly displayed codes privately. They are shown only in this
   response, never sent by email or stored in browser storage. Every old code is
   invalidated; all other application sessions are revoked in the transaction.
4. Each code works once. Replacement consumes the current session's step-up
   proof, so verify again before another sensitive action. If the response is
   lost, verify the authenticator again and replace the codes once more.

Encrypted code storage uses Better Auth's current versioned encryption key.
The integration suite verifies compatibility with its actual verification
handler. Re-run these tests when upgrading Better Auth.

## Lost authenticator AND recovery codes

1. The owner signs out and signs in using their existing Google/email account.
2. Within 15 minutes, open Account security → **Lost both your authenticator and
   recovery codes?** and request recovery. There is no factor bypass yet.
3. Contact a known administrator through a previously established channel and
   provide the request reference. No automatic notification is sent. Requests
   expire after 24 hours; the owner can cancel a pending request at any time.
4. A different administrator independently verifies the person and request.
   A reference, incoming email, display name or control of a signed-in browser
   alone is insufficient. Use a known contact channel or an established
   in-person procedure; do not accept a newly supplied phone number as proof.
   Never ask for passwords, TOTP secrets, session tokens or recovery codes.
5. That administrator verifies their own authenticator within 15 minutes, opens
   User management → Authenticator recovery, records a non-secret verification
   note, checks the identity confirmation, and approves the matching reference.
6. Approval atomically clears the requesting owner's factor, disables their
   factor flag, revokes their sessions, and records the administrator, target,
   reference and reason in the moderation audit. It does not change roles,
   email addresses, Google links, bans or provider credentials. An inactive,
   unverified, expired, cancelled or changed-factor request is rejected.
7. The owner signs in again and enrolls a new authenticator immediately. Staff
   tools remain blocked until enrollment AND session-scoped verification.
   Confirm access with the owner through the established channel.

Retries of an approved reference do not reset a newly enrolled authenticator.
Recovery requests have one record per account and a 24-hour TTL. Expiration is
also checked in application code, since database cleanup is asynchronous.
Approval history remains under the service's moderation-audit retention policy;
the broader retention policy still needs to be finalized before launch.
Account export includes the owner's recovery request without factor details;
deletion removes their request and removes links to them as an approving admin.

## When this workflow cannot help

- Lost Google/mailbox access: recover it with the identity provider first. This
  app deliberately cannot substitute another email or impersonate the user.
- All administrators lost their factors: no administrator can self-approve.
  Escalate to the verified service operator using separately secured provider
  access. Do not disable MFA, add a public reset endpoint, or edit production
  roles opportunistically. An operator-assisted, independently verified recovery
  procedure remains to be agreed with the owner; this is why a tested backup
  administrator is a launch prerequisite.
- Suspected compromised Google account: recover and secure that account first;
  application session revocation does not revoke provider sessions or tokens.
- Suspected compromise of an administrator: use another secured administrator
  to suspend the account, preserve audit evidence, and follow incident response.

## Release prerequisite

Apply and verify index migration `2026-09-staff-history-v6` (which includes the
recovery indexes introduced by `2026-09-account-recovery-v5`) against the intended
database before deploying these routes. Promote matching frontend and backend
versions. Preserve the existing `VOTER_SECRET` release prerequisite from
SECRET-ROTATION.md. Local tests do not verify production admin enrollment,
provider configuration, support monitoring, or production index state.
