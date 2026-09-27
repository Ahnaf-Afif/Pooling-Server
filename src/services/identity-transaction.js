import AuthSession from "../models/AuthSession.js";
import AuthUser from "../models/AuthUser.js";
import { withDatabaseTransaction } from "../db.js";
import { isRecent, STAFF_SESSION_MS } from "../security-policy.js";
import { idCandidates, lockAdminChanges } from "./user-admin.js";

export class IdentityError extends Error {
  constructor(message, status = 401, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// A middleware result is only a snapshot. A real write to these same documents
// makes deletion, suspension, role changes and session revocation conflict with
// this transaction. A retry rechecks current authority before doing any work.
export async function lockIdentity(identity, session, { role, recent = false, factor = false, freshSignIn = false } = {}) {
  if (!session) throw new Error("Identity guards require a database transaction");
  if (!identity?.user?.id || !identity.session?.token) throw new IdentityError("Sign in to continue");
  const user = await AuthUser.findOne({ _id: { $in: idCandidates(identity.user.id) } }).session(session).lean();
  const current = await AuthSession.findOne({ token: identity.session.token, userId: { $in: idCandidates(identity.user.id) } }).session(session).lean();
  if (!user || !current || !(new Date(current.expiresAt).getTime() > Date.now())) throw new IdentityError("Sign in again to continue");
  if (user.banned || !user.emailVerified) throw new IdentityError("A verified, active account is required", 403);

  const roles = String(user.role || "user").split(",");
  const effectiveRole = roles.includes("admin") ? "admin" : roles.includes("moderator") ? "moderator" : "user";
  if (role && (role === "admin" ? effectiveRole !== "admin" : effectiveRole === "user")) {
    throw new IdentityError(role === "admin" ? "Administrator access required" : "Moderator access required", 403);
  }
  if (role && !isRecent(current.createdAt, STAFF_SESSION_MS)) throw new IdentityError("Sign in again to renew staff access", 403, "REAUTH_REQUIRED");
  if ((role || factor) && (!user.twoFactorEnabled || !isRecent(current.mfaVerifiedAt))) {
    throw new IdentityError("Verify your authenticator before this action", 403, "MFA_REQUIRED");
  }
  const recentlyVerified = user.twoFactorEnabled ? isRecent(current.mfaVerifiedAt) : isRecent(current.createdAt);
  if ((freshSignIn && !isRecent(current.createdAt)) || (recent && !recentlyVerified)) {
    throw new IdentityError("Verify your authenticator, or sign out and sign in again, before this action", 403, "REAUTH_REQUIRED");
  }
  const lockedUser = await AuthUser.updateOne({ _id: user._id }, { $inc: { securityRevision: 1 } }, { session });
  const lockedSession = await AuthSession.updateOne({ _id: current._id }, { $inc: { securityRevision: 1 } }, { session });
  if (!lockedUser.matchedCount || !lockedSession.matchedCount) throw new IdentityError("Account access changed. Sign in again.");
  return { user, current, effectiveRole };
}

export function withIdentityTransaction(identity, work, policy = {}) {
  return withDatabaseTransaction(async (session) => {
    // Keep the global administrator guard first, matching deletion/recovery.
    if (policy.adminChanges) await lockAdminChanges(session);
    const principal = await lockIdentity(identity, session, policy);
    return work(session, principal);
  });
}
