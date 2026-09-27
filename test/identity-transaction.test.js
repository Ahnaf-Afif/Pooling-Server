import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import AuthUser from "../src/models/AuthUser.js";
import AuthSession from "../src/models/AuthSession.js";
import { IdentityError, lockIdentity } from "../src/services/identity-transaction.js";

const original = { userFind: AuthUser.findOne, userUpdate: AuthUser.updateOne, sessionFind: AuthSession.findOne, sessionUpdate: AuthSession.updateOne };
const transaction = { testTransaction: true };
const identity = { user: { id: "user-id", role: "admin", twoFactorEnabled: false }, session: { token: "session-token" } };
let user, session, writes, matchedCount;

beforeEach(() => {
  user = { _id: "user-id", role: "admin", emailVerified: true, banned: false, twoFactorEnabled: true };
  session = { _id: "session-id", createdAt: new Date(), mfaVerifiedAt: new Date(), expiresAt: new Date(Date.now() + 60_000) };
  writes = [];
  matchedCount = 1;
  const query = (value) => ({ session(value) { assert.equal(value, transaction); return this; }, lean: async () => value });
  AuthUser.findOne = (filter) => { assert.deepEqual(filter._id.$in, [identity.user.id]); return query(user); };
  AuthSession.findOne = (filter) => {
    assert.equal(filter.token, identity.session.token);
    assert.deepEqual(filter.userId.$in, [identity.user.id]);
    return query(session);
  };
  AuthUser.updateOne = AuthSession.updateOne = async (filter, update, options) => {
    assert.equal(options.session, transaction);
    assert.deepEqual(update, { $inc: { securityRevision: 1 } });
    writes.push(filter._id);
    return { matchedCount };
  };
});

afterEach(() => {
  AuthUser.findOne = original.userFind;
  AuthUser.updateOne = original.userUpdate;
  AuthSession.findOne = original.sessionFind;
  AuthSession.updateOne = original.sessionUpdate;
});

test("identity guard locks both authoritative records and returns the stored principal", async () => {
  const result = await lockIdentity(identity, transaction, { role: "admin" });
  assert.equal(result.user, user);
  assert.equal(result.current, session);
  assert.equal(result.effectiveRole, "admin");
  assert.deepEqual(writes, ["user-id", "session-id"]);
});

test("missing, expired, suspended and unverified identities cannot write", async () => {
  await assert.rejects(lockIdentity(identity, null), /transaction/);
  await assert.rejects(lockIdentity(null, transaction), IdentityError);
  const originalUser = user;
  const originalSession = session;
  for (const state of [
    [null, originalSession], [originalUser, null],
    [originalUser, { ...originalSession, expiresAt: new Date(0) }],
    [originalUser, { ...originalSession, expiresAt: "invalid" }],
    [{ ...originalUser, banned: true }, originalSession],
    [{ ...originalUser, emailVerified: false }, originalSession],
  ]) {
    [user, session] = state;
    await assert.rejects(lockIdentity(identity, transaction), IdentityError);
  }
  assert.deepEqual(writes, []);
});

test("staff role and MFA requirements use current database values, not middleware values", async () => {
  user.role = "moderator";
  await assert.rejects(lockIdentity(identity, transaction, { role: "admin" }), { status: 403 });
  user.role = "user";
  await assert.rejects(lockIdentity(identity, transaction, { role: "staff" }), { status: 403 });
  user.role = "admin";
  user.twoFactorEnabled = false;
  await assert.rejects(lockIdentity(identity, transaction, { role: "staff" }), { code: "MFA_REQUIRED" });
  user.twoFactorEnabled = true;
  session.mfaVerifiedAt = new Date(Date.now() - 16 * 60_000);
  await assert.rejects(lockIdentity(identity, transaction, { role: "admin" }), { code: "MFA_REQUIRED" });
  session.mfaVerifiedAt = new Date();
  session.createdAt = new Date(Date.now() - 13 * 60 * 60_000);
  await assert.rejects(lockIdentity(identity, transaction, { role: "staff" }), { code: "REAUTH_REQUIRED" });
  assert.deepEqual(writes, []);
});

test("recent-auth policy cannot substitute a fresh sign-in for an enabled factor", async () => {
  session.mfaVerifiedAt = null;
  await assert.rejects(lockIdentity(identity, transaction, { recent: true }), { code: "REAUTH_REQUIRED" });
  user.twoFactorEnabled = false;
  await lockIdentity(identity, transaction, { recent: true });
  user.twoFactorEnabled = true;
  await lockIdentity(identity, transaction, { freshSignIn: true });
  session.createdAt = new Date(0);
  await assert.rejects(lockIdentity(identity, transaction, { freshSignIn: true }), { code: "REAUTH_REQUIRED" });
});

test("identity guard rejects a missing write match rather than proceeding unguarded", async () => {
  matchedCount = 0;
  await assert.rejects(lockIdentity(identity, transaction), { status: 401 });
});
