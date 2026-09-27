import { createHash, randomBytes, randomUUID } from "node:crypto";
import { symmetricEncrypt } from "better-auth/crypto";

import { auth } from "../auth.js";
import { getMongoDatabase, withDatabaseTransaction } from "../db.js";
import RecoveryRequest from "../models/RecoveryRequest.js";
import ModerationAction from "../models/ModerationAction.js";
import { isRecent, STAFF_SESSION_MS } from "../security-policy.js";
import { idCandidates, lockAdminChanges, UserAdminError } from "./user-admin.js";

const userFilter = (id) => ({ _id: { $in: idCandidates(id) } });
const factorFilter = (id) => ({ userId: { $in: idCandidates(id) } });
const fingerprint = (factor) => createHash("sha256").update(`${factor._id}:${factor.secret}`).digest("hex");
const fail = (message, status = 409) => { throw new UserAdminError(message, status); };

export function publicRecovery(request) {
  return request ? { requestId: request.requestId, status: request.status, expiresAt: request.expiresAt } : null;
}

// Recheck and write-lock the real session and user inside the transaction:
// revocation, deletion, suspension and a concurrent recovery must not race us.
async function lockIdentity(identity, session, { freshSignIn = false, administrator = false } = {}) {
  const database = getMongoDatabase();
  const user = await database.collection("user").findOne(userFilter(identity.user.id), { session });
  const current = await database.collection("session").findOne({ token: identity.session.token, ...factorFilter(identity.user.id) }, { session });
  if (!user || user.banned || !user.emailVerified || !current || current.expiresAt <= new Date()) fail("Sign in with an active verified account", 401);
  if (freshSignIn ? !isRecent(current.createdAt) : !user.twoFactorEnabled || !isRecent(current.mfaVerifiedAt)) {
    fail(freshSignIn ? "Sign out and sign in again before requesting recovery" : "Verify your authenticator or a recovery code before this action", 403);
  }
  if (administrator && (!String(user.role || "").split(",").includes("admin") || !isRecent(current.createdAt, STAFF_SESSION_MS))) fail("Fresh administrator verification required", 403);
  await database.collection("user").updateOne({ _id: user._id }, { $inc: { securityRevision: 1 } }, { session });
  await database.collection("session").updateOne({ _id: current._id }, { $inc: { securityRevision: 1 } }, { session });
  return { user, current };
}

export async function replaceRecoveryCodes(identity) {
  const database = getMongoDatabase();
  const factor = await database.collection("twoFactor").findOne(factorFilter(identity.user.id));
  if (!factor) fail("Set up and verify an authenticator first");
  const backupCodes = Array.from({ length: 10 }, () => {
    const value = randomBytes(10).toString("hex");
    return `${value.slice(0, 10)}-${value.slice(10)}`;
  });
  const context = await auth.$context;
  const encrypted = await symmetricEncrypt({ key: context.secretConfig, data: JSON.stringify(backupCodes) });
  await withDatabaseTransaction(async (session) => {
    const { current } = await lockIdentity(identity, session);
    const updated = await database.collection("twoFactor").updateOne(
      { _id: factor._id, secret: factor.secret, backupCodes: factor.backupCodes },
      { $set: { backupCodes: encrypted } }, { session },
    );
    if (!updated.matchedCount) fail("Security settings changed. Verify again before replacing codes.");
    await database.collection("session").deleteMany({ ...factorFilter(identity.user.id), _id: { $ne: current._id } }, { session });
    // One replacement per verification, including simultaneous/retried calls.
    await database.collection("session").updateOne({ _id: current._id }, { $unset: { mfaVerifiedAt: "" } }, { session });
    await RecoveryRequest.deleteOne({ _id: identity.user.id }, { session });
  });
  return backupCodes;
}

export async function requestRecovery(identity) {
  return withDatabaseTransaction(async (session) => {
    const { user } = await lockIdentity(identity, session, { freshSignIn: true });
    if (!user.twoFactorEnabled) fail("No enabled authenticator needs recovery");
    const factor = await getMongoDatabase().collection("twoFactor").findOne(factorFilter(identity.user.id), { session });
    if (!factor) fail("Authenticator record is missing; contact the service operator");
    const existing = await RecoveryRequest.findById(identity.user.id).select("+factorFingerprint").session(session).lean();
    if (existing?.status === "pending" && existing.expiresAt > new Date() && existing.factorFingerprint === fingerprint(factor)) return publicRecovery(existing);
    const request = await RecoveryRequest.findOneAndUpdate({ _id: identity.user.id }, { $set: {
      requestId: randomUUID(), status: "pending", factorFingerprint: fingerprint(factor),
      createdAt: new Date(), expiresAt: new Date(Date.now() + 24 * 60 * 60_000), approvedAt: null, approvedBy: null,
    } }, { upsert: true, returnDocument: "after", session });
    return publicRecovery(request);
  });
}

export async function approveRecovery(identity, requestId, note) {
  return withDatabaseTransaction(async (session) => {
    await lockAdminChanges(session);
    const { user: actor } = await lockIdentity(identity, session, { administrator: true });
    const request = await RecoveryRequest.findOne({ requestId }).select("+factorFingerprint").session(session);
    if (!request || request.expiresAt <= new Date()) fail("Recovery request expired or was cancelled", 404);
    if (request._id === identity.user.id) fail("Another administrator must approve your recovery", 403);
    if (request.status === "approved") return { replayed: true };
    const database = getMongoDatabase();
    const target = await database.collection("user").findOne(userFilter(request._id), { session });
    if (!target || target.banned || !target.emailVerified || !target.twoFactorEnabled) fail("The requesting account is no longer eligible for recovery");
    const factor = await database.collection("twoFactor").findOne(factorFilter(request._id), { session });
    if (!factor || fingerprint(factor) !== request.factorFingerprint) fail("Authenticator changed. Ask the account owner to submit a new request.");
    await database.collection("twoFactor").deleteOne({ _id: factor._id }, { session });
    await database.collection("user").updateOne({ _id: target._id }, { $set: { twoFactorEnabled: false, updatedAt: new Date() }, $inc: { securityRevision: 1 } }, { session });
    await database.collection("session").deleteMany(factorFilter(request._id), { session });
    request.status = "approved";
    request.approvedAt = new Date();
    request.approvedBy = identity.user.id;
    await request.save({ session });
    await ModerationAction.create([{
      action: "factor_recovered", actorId: identity.user.id, actorName: (actor.name?.trim() || "Administrator").slice(0, 160),
      actorRole: "admin", targetUserId: request._id, note,
      before: { twoFactorEnabled: true }, after: { twoFactorEnabled: false, sessionsRevoked: true, requestId },
    }], { session });
    return { replayed: false };
  });
}
