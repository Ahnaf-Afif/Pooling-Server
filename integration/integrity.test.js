import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { ObjectId } from "mongodb";
import { makeSignature, symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import { createOTP } from "@better-auth/utils/otp";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { rotateAuthEncryption } from "../src/services/auth-encryption.js";
import { getPlatformStats } from "../src/services/platform-stats.js";

// Always create an isolated local replica set. Never read .env or reuse Atlas.
let replicaSet, server, baseUrl, database, auth, closeDatabases, withDatabaseTransaction;
let Poll, Report, ModerationAction, VoteReceipt, AdminGuard, setAuthUserRole;
const secret = "integration-test-secret-only-0123456789abcdef";

before(async () => {
  replicaSet = await MongoMemoryReplSet.create({
    binary: {
      version: "7.0.24",
      downloadDir: process.env.MONGOMS_DOWNLOAD_DIR || "/tmp/wdyt-mongodb-binaries",
      os: { os: "linux", dist: "ubuntu", release: "22.04" },
    },
    replSet: { count: 1, storageEngine: "wiredTiger" },
  });
  process.env.MONGODB_URI = replicaSet.getUri("wdyt_integration");
  process.env.NODE_ENV = "test";
  process.env.BETTER_AUTH_SECRET = secret;
  process.env.VOTER_SECRET = secret;
  process.env.BETTER_AUTH_URL = "http://localhost:3000";
  delete process.env.BETTER_AUTH_SECRETS;
  delete process.env.RESEND_API_KEY;
  delete process.env.GOOGLE_CLIENT_SECRET;
  const db = await import("../src/db.js");
  closeDatabases = db.closeDatabases;
  withDatabaseTransaction = db.withDatabaseTransaction;
  await db.connectDatabase();
  database = db.getMongoDatabase();
  ({ default: Poll } = await import("../src/models/Poll.js"));
  ({ default: Report } = await import("../src/models/Report.js"));
  ({ default: ModerationAction } = await import("../src/models/ModerationAction.js"));
  ({ default: VoteReceipt } = await import("../src/models/VoteReceipt.js"));
  ({ default: AdminGuard } = await import("../src/models/AdminGuard.js"));
  ({ setAuthUserRole } = await import("../src/services/user-admin.js"));
  ({ auth } = await import("../src/auth.js"));
  const { default: app } = await import("../src/app.js");
  for (const model of [Poll, Report, ModerationAction, VoteReceipt, AdminGuard]) await model.createIndexes();
  const { syncIndexes } = await import("../scripts/sync-indexes.js");
  await syncIndexes({ apply: true });
  await new Promise((resolve, reject) => {
    server = app.listen(0, "127.0.0.1", resolve);
    server.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}, { timeout: 180_000 });

beforeEach(async () => {
  // Every collection here belongs to the temporary replica set above.
  for (const collection of await database.collections()) await collection.deleteMany({});
  await AdminGuard.create({ _id: "administrators", revision: 0 });
});

after(async () => {
  if (server) await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
  await closeDatabases?.();
  await replicaSet?.stop();
});

async function createUser(role = "user") {
  const _id = new ObjectId();
  await database.collection("user").insertOne({
    _id, name: `Test ${role}`, email: `${_id}@example.test`, emailVerified: true,
    role, banned: false, createdAt: new Date(), updatedAt: new Date(),
  });
  const context = await auth.$context;
  const session = await context.internalAdapter.createSession(String(_id), false);
  const signed = `${session.token}.${await makeSignature(session.token, secret)}`;
  return { id: String(_id), _id, cookie: `better-auth.session_token=${encodeURIComponent(signed)}` };
}

async function createPoll(creatorId = null) {
  return Poll.create({ slug: `test-${new ObjectId()}`, question: "Which option do you prefer?", category: "Tech", creatorId, options: [{ label: "One" }, { label: "Two" }] });
}

function post(path, cookie, body = {}) {
  return fetch(`${baseUrl}${path}`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: "http://localhost:3000", ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });
}

test("account deletion preserves other moderators' attribution and clears both ID formats", async () => {
  const user = await createUser("moderator");
  const poll = await createPoll(user.id);
  const targetAction = await ModerationAction.create({ action: "user_suspended", actorId: "other-admin", actorName: "Other admin", actorRole: "admin", targetUserId: user.id });
  const authoredAction = await ModerationAction.create({ action: "poll_edited", actorId: user.id, actorName: "Deleting moderator", actorRole: "moderator", targetUserId: "another-owner", pollSlug: poll.slug });
  await database.collection("account").insertMany([{ userId: user._id, providerId: "google" }, { userId: user.id, providerId: "legacy" }]);
  await database.collection("twoFactor").insertOne({ userId: user._id, secret: "test-only" });
  const { getAccountVoterKey } = await import("../src/voter.js");
  const voterKey = getAccountVoterKey(user.id);
  await VoteReceipt.create({ pollSlug: poll.slug, voterKey, optionId: poll.options[0]._id });
  const report = await Report.create({ pollSlug: poll.slug, reporterKey: voterKey, reporterUserId: user.id, reviewedBy: user.id, reason: "spam" });

  const response = await post("/api/account/delete", user.cookie, { confirmation: "DELETE" });
  assert.equal(response.status, 204, await response.text());
  const keptActor = await ModerationAction.findById(targetAction._id).lean();
  assert.equal(keptActor.actorId, "other-admin");
  assert.equal(keptActor.actorName, "Other admin");
  assert.equal(keptActor.targetUserId, null);
  const removedActor = await ModerationAction.findById(authoredAction._id).lean();
  assert.match(removedActor.actorId, /^deleted:/);
  assert.equal(removedActor.targetUserId, "another-owner");
  const removedReport = await Report.findById(report._id).lean();
  assert.equal(removedReport.reviewedBy, null);
  assert.equal(removedReport.reporterUserId, null);
  assert.notEqual(removedReport.reporterKey, voterKey);
  for (const collection of ["user", "session", "account", "twoFactor"]) assert.equal(await database.collection(collection).countDocuments({}), 0, collection);
  assert.equal(await VoteReceipt.countDocuments({ voterKey }), 0);
  assert.equal(await VoteReceipt.countDocuments({}), 1);
  assert.equal((await Poll.findById(poll._id)).creatorId, null);
  assert.equal((await fetch(`${baseUrl}/api/account/export`, { headers: { Cookie: user.cookie } })).status, 401);
});

test("deleting the last administrator is rejected without deleting anything", async () => {
  const admin = await createUser("admin");
  const response = await post("/api/account/delete", admin.cookie, { confirmation: "DELETE" });
  assert.equal(response.status, 409);
  assert.equal(await database.collection("user").countDocuments({}), 1);
  assert.equal(await database.collection("session").countDocuments({}), 1);
});

test("concurrent demotions cannot remove every administrator", async () => {
  const admins = await Promise.all([createUser("admin"), createUser("admin")]);
  const results = await Promise.allSettled(admins.map((admin) => withDatabaseTransaction((session) => setAuthUserRole(admin.id, "user", { session }))));
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(await database.collection("user").countDocuments({ role: "admin" }), 1);
});

test("concurrent duplicate votes create exactly one receipt and one count", async () => {
  const user = await createUser();
  const poll = await createPoll();
  const responses = await Promise.all(Array.from({ length: 8 }, () => post(`/api/polls/${poll.slug}/votes`, user.cookie, { optionId: String(poll.options[0]._id) })));
  assert.equal(responses.filter((response) => response.status === 200).length, 8);
  const results = await Promise.all(responses.map((response) => response.json()));
  assert.equal(results.filter((result) => result.replayed === false).length, 1);
  assert.equal(results.filter((result) => result.replayed === true).length, 7);
  assert.equal(await VoteReceipt.countDocuments({ pollSlug: poll.slug }), 1);
  const saved = await Poll.findById(poll._id);
  assert.equal(saved.totalVotes, 1);
  assert.equal(saved.options[0].votes, 1);
});

test("a rejected vote rolls back its receipt", async () => {
  const user = await createUser();
  const poll = await createPoll();
  poll.status = "closed";
  await poll.save();
  const response = await post(`/api/polls/${poll.slug}/votes`, user.cookie, { optionId: String(poll.options[0]._id) });
  assert.equal(response.status, 409);
  assert.equal(await VoteReceipt.countDocuments({}), 0);
  assert.equal((await Poll.findById(poll._id)).totalVotes, 0);
});

test("a failed audit insert rolls back poll removal and report resolution", async () => {
  const admin = await createUser("admin");
  await database.collection("user").updateOne({ _id: admin._id }, { $set: { twoFactorEnabled: true } });
  await database.collection("session").updateMany({}, { $set: { mfaVerifiedAt: new Date() } });
  const poll = await createPoll();
  const report = await Report.create({ pollSlug: poll.slug, reporterKey: "reporter", reason: "spam" });
  const original = ModerationAction.create;
  ModerationAction.create = async () => { throw new Error("Injected audit storage failure"); };
  try {
    const response = await post(`/api/moderation/reports/${report._id}/remove-poll`, admin.cookie, { note: "Test rollback" });
    assert.equal(response.status, 500);
    assert.equal((await Poll.findById(poll._id)).deletedAt, null);
    assert.equal((await Report.findById(report._id)).status, "pending");
    assert.equal(await ModerationAction.countDocuments({}), 0);
  } finally { ModerationAction.create = original; }
});

function updatedCookie(response, fallback) {
  return response.headers.getSetCookie().find((cookie) => cookie.startsWith("better-auth.session_token="))?.split(";", 1)[0] || fallback;
}

test("Google-style staff sessions need MFA; enrollment and recovery unlock only the verified session", async () => {
  const admin = await createUser("admin");
  const readQueue = (cookie) => fetch(`${baseUrl}/api/moderation/reports`, { headers: { Cookie: cookie } });
  assert.equal((await readQueue(admin.cookie)).status, 403);
  const enrollment = await post("/api/account/security/enable", admin.cookie);
  assert.equal(enrollment.status, 200, await enrollment.clone().text());
  const { backupCodes } = await enrollment.json();
  const record = await database.collection("twoFactor").findOne({});
  const context = await auth.$context;
  const totpSecret = await symmetricDecrypt({ key: context.secretConfig, data: record.secret });
  const code = await createOTP(totpSecret).totp();
  const verified = await post("/api/account/security/verify", admin.cookie, { code });
  assert.equal(verified.status, 200, await verified.clone().text());
  const cookie = updatedCookie(verified, admin.cookie);
  assert.equal((await readQueue(cookie)).status, 200);

  // An independent Google session has no second-factor proof.
  const second = await context.internalAdapter.createSession(admin.id, false);
  const secondCookie = `better-auth.session_token=${encodeURIComponent(`${second.token}.${await makeSignature(second.token, secret)}`)}`;
  assert.equal((await readQueue(secondCookie)).status, 403);
  assert.equal((await post("/api/account/security/verify", secondCookie, { code })).status, 409);
  const recovered = await post("/api/account/security/verify", secondCookie, { code: backupCodes[0], backup: true });
  assert.equal(recovered.status, 200, await recovered.clone().text());
  assert.equal((await readQueue(secondCookie)).status, 200);
  assert.equal((await post("/api/account/security/verify", secondCookie, { code: backupCodes[0], backup: true })).status, 401);
  assert.equal((await post("/api/account/security/disable", secondCookie)).status, 403);

  await database.collection("session").updateOne({ token: second.token }, { $set: { mfaVerifiedAt: new Date(Date.now() - 16 * 60_000) } });
  assert.equal((await post("/api/moderation/users/nobody/suspend", secondCookie, { note: "Must require a fresh factor" })).status, 403);
  await database.collection("session").updateOne({ token: second.token }, { $set: { createdAt: new Date(Date.now() - 13 * 60 * 60_000) } });
  assert.equal((await readQueue(secondCookie)).status, 403);
});

test("old sessions cannot delete accounts or enroll a new authenticator", async () => {
  const user = await createUser();
  await database.collection("session").updateMany({}, { $set: { createdAt: new Date(Date.now() - 16 * 60_000) } });
  assert.equal((await post("/api/account/delete", user.cookie, { confirmation: "DELETE" })).status, 403);
  assert.equal((await post("/api/account/security/enable", user.cookie)).status, 403);
  assert.equal(await database.collection("user").countDocuments({}), 1);
});

test("session list omits credentials and revocation cannot target another account", async () => {
  const first = await createUser();
  const other = await createUser();
  const context = await auth.$context;
  await context.internalAdapter.createSession(first.id, false);
  const result = await fetch(`${baseUrl}/api/account/security/sessions`, { headers: { Cookie: first.cookie } });
  const data = await result.json();
  assert.equal(data.sessions.length, 2);
  assert.ok(data.sessions.every((session) => !session.token && !session.userId));
  const otherSession = await database.collection("session").findOne({ userId: other._id });
  await post("/api/account/security/sessions/revoke", first.cookie, { id: String(otherSession._id) });
  assert.ok(await database.collection("session").findOne({ _id: otherSession._id }));
  await post("/api/account/security/sessions/revoke", first.cookie, { others: true });
  assert.equal(await database.collection("session").countDocuments({ userId: first._id }), 1);
});

test("built-in privileged endpoints are disabled even for an authenticated administrator", async () => {
  const admin = await createUser("admin");
  const paths = auth.options.disabledPaths;
  assert.ok(paths.length >= 15);
  for (const path of paths) {
    const response = await post(`/api/auth${path}`, admin.cookie, { userId: admin.id, role: "user" });
    assert.equal(response.status, 404, path);
  }
  const sessionCount = await database.collection("session").countDocuments({});
  for (const path of ["list-sessions", "revoke-session", "revoke-sessions", "revoke-other-sessions"]) {
    const response = await fetch(`${baseUrl}/api/auth/${path}`, { headers: { Cookie: admin.cookie } });
    assert.equal(response.status, 404, `GET ${path}`);
  }
  assert.equal(await database.collection("session").countDocuments({}), sessionCount);
  assert.equal((await database.collection("user").findOne({ _id: admin._id })).role, "admin");
});

test("suspension preserves pending reports; already removed content can then be resolved", async () => {
  const admin = await createUser("admin");
  const owner = await createUser();
  await database.collection("user").updateOne({ _id: admin._id }, { $set: { twoFactorEnabled: true } });
  await database.collection("session").updateMany({ userId: admin._id }, { $set: { mfaVerifiedAt: new Date() } });
  const poll = await createPoll(owner.id);
  const report = await Report.create({ pollSlug: poll.slug, reporterKey: "reporter", reason: "spam" });
  const suspended = await post(`/api/moderation/reports/${report._id}/suspend-owner`, admin.cookie, { note: "Repeated spam" });
  assert.equal(suspended.status, 200, await suspended.text());
  assert.equal((await database.collection("user").findOne({ _id: owner._id })).banned, true);
  assert.equal(await database.collection("session").countDocuments({ userId: owner._id }), 0);
  assert.equal((await Report.findById(report._id)).status, "pending");
  assert.equal((await Poll.findById(poll._id)).deletedAt, null);
  assert.equal(await ModerationAction.countDocuments({ action: "owner_suspended", reportId: report._id }), 1);

  await Poll.updateOne({ _id: poll._id }, { $set: { deletedAt: new Date(), status: "archived" } });
  const removed = await post(`/api/moderation/reports/${report._id}/remove-poll`, admin.cookie, { note: "Content already removed" });
  assert.equal(removed.status, 200, await removed.text());
  assert.equal((await Report.findById(report._id)).status, "resolved");
  assert.equal(await ModerationAction.countDocuments({ action: "poll_removed", reportId: report._id }), 1);
});

test("required-index verification detects drift and migration repairs it", async () => {
  const { syncIndexes, verifyIndexes } = await import("../scripts/sync-indexes.js");
  await verifyIndexes();
  await database.collection("twoFactor").dropIndex("two_factor_user_unique");
  await assert.rejects(verifyIndexes, /twoFactor/);
  await syncIndexes({ apply: true });
  await verifyIndexes();
  assert.equal(await database.collection("migrations").countDocuments({}), 1);
});

test("auth secret rotation preserves duplicate protection, export and deletion of existing votes", async () => {
  const user = await createUser();
  const poll = await createPoll();
  const path = `/api/polls/${poll.slug}/votes`;
  const body = { optionId: String(poll.options[0]._id) };
  assert.equal((await post(path, user.cookie, body)).status, 200);
  const original = process.env.BETTER_AUTH_SECRET;
  try {
    process.env.BETTER_AUTH_SECRET = "rotated-auth-signing-key-test-only-0123456789";
    const retried = await post(path, user.cookie, { optionId: body.optionId.toUpperCase() });
    assert.equal(retried.status, 200);
    assert.equal((await retried.json()).replayed, true);
    assert.equal((await Poll.findById(poll._id)).totalVotes, 1);
    const exported = await fetch(`${baseUrl}/api/account/export`, { headers: { Cookie: user.cookie } });
    assert.equal(exported.status, 200);
    assert.equal((await exported.json()).votes.length, 1);
    const { getAccountVoterKey } = await import("../src/voter.js");
    const key = getAccountVoterKey(user.id);
    assert.equal((await post("/api/account/delete", user.cookie, { confirmation: "DELETE" })).status, 204);
    assert.equal(await VoteReceipt.countDocuments({ voterKey: key }), 0);
    assert.equal(await VoteReceipt.countDocuments({}), 1);
  } finally { process.env.BETTER_AUTH_SECRET = original; }
});

function rotationKeys() {
  const previous = { currentVersion: 1, keys: new Map([[1, secret]]), legacySecret: secret };
  const current = { currentVersion: 2, keys: new Map([[2, "new-encryption-key-test-only-0123456789"], [1, secret]]), legacySecret: secret };
  return { previous, current };
}

test("rotation upgrades OAuth, legacy ciphertext, TOTP and recovery codes without changing their values", async () => {
  const { previous, current } = rotationKeys();
  const account = {
    providerId: "google", accountId: "rotation-test",
    accessToken: await symmetricEncrypt({ key: previous, data: "test-access" }),
    refreshToken: await symmetricEncrypt({ key: secret, data: "test-refresh" }),
    idToken: await symmetricEncrypt({ key: current, data: "test-id" }),
  };
  const factor = {
    userId: new ObjectId(),
    secret: await symmetricEncrypt({ key: previous, data: "test-totp" }),
    backupCodes: await symmetricEncrypt({ key: previous, data: '["test-unused-code"]' }),
  };
  await database.collection("account").insertOne(account);
  await database.collection("twoFactor").insertOne(factor);
  const dryRun = await rotateAuthEncryption(database, current);
  assert.equal(dryRun.outdated, 4);
  assert.equal(dryRun.changed, 0);
  assert.equal((await database.collection("account").findOne({})).accessToken, account.accessToken);
  await assert.rejects(() => rotateAuthEncryption(database, current, { verify: true }), /4 encrypted fields/);
  const applied = await rotateAuthEncryption(database, current, { apply: true });
  assert.equal(applied.changed, 4);
  assert.equal(applied.outdated, 0);
  const retired = { currentVersion: 2, keys: new Map([[2, current.keys.get(2)]]) };
  for (const [collection, expected] of [
    ["account", { accessToken: "test-access", refreshToken: "test-refresh", idToken: "test-id" }],
    ["twoFactor", { secret: "test-totp", backupCodes: '["test-unused-code"]' }],
  ]) {
    const document = await database.collection(collection).findOne({});
    for (const [field, value] of Object.entries(expected)) {
      assert.equal(await symmetricDecrypt({ key: retired, data: document[field] }), value);
    }
  }
  await rotateAuthEncryption(database, retired, { verify: true });
  assert.equal((await rotateAuthEncryption(database, retired, { apply: true })).changed, 0);
});

test("rotation preflight leaves all records untouched if any ciphertext cannot be decrypted", async () => {
  const { previous, current } = rotationKeys();
  const token = await symmetricEncrypt({ key: previous, data: "valid-test-token" });
  await database.collection("account").insertOne({ providerId: "google", accountId: "preflight-test", accessToken: token });
  await database.collection("twoFactor").insertOne({ userId: new ObjectId(), secret: "$ba$99$unknown-key" });
  await assert.rejects(() => rotateAuthEncryption(database, current, { apply: true }), /Cannot decrypt twoFactor.secret/);
  assert.equal((await database.collection("account").findOne({})).accessToken, token);
});

test("rotation never overwrites a concurrently refreshed OAuth token", async () => {
  const { previous, current } = rotationKeys();
  const collection = database.collection("account");
  await collection.insertOne({ providerId: "google", accountId: "concurrency-test", accessToken: await symmetricEncrypt({ key: previous, data: "old-test-token" }) });
  const refreshed = await symmetricEncrypt({ key: current, data: "new-test-token" });
  const concurrentDatabase = { collection(name) {
    if (name !== "account") return database.collection(name);
    return {
      find: (...args) => collection.find(...args),
      async updateOne(filter, update) {
        await collection.updateOne({ _id: filter._id }, { $set: { accessToken: refreshed } });
        return collection.updateOne(filter, update);
      },
    };
  } };
  await assert.rejects(() => rotateAuthEncryption(concurrentDatabase, current, { apply: true }), /Concurrent auth updates/);
  assert.equal((await collection.findOne({})).accessToken, refreshed);
  await rotateAuthEncryption(database, current, { verify: true });
});

test("poll cursors handle equal timestamps and new insertions without offsets or duplicate rows", async () => {
  const owner = await createUser();
  const other = await createUser();
  const originals = [];
  for (let index = 0; index < 5; index += 1) originals.push(await createPoll(owner.id));
  await database.collection("polls").updateMany({}, { $set: { createdAt: new Date("2026-01-01T00:00:00Z") } });
  const first = await (await fetch(`${baseUrl}/api/polls?limit=2&stats=false`)).json();
  assert.equal(first.polls.length, 2);
  await createPoll(other.id);
  const slugs = first.polls.map((poll) => poll.id);
  let cursor = first.nextCursor;
  while (cursor) {
    const response = await fetch(`${baseUrl}/api/polls?limit=2&cursor=${cursor}`);
    assert.equal(response.status, 200);
    const page = await response.json();
    assert.equal(page.stats, undefined);
    slugs.push(...page.polls.map((poll) => poll.id));
    cursor = page.nextCursor;
  }
  assert.equal(new Set(slugs).size, originals.length);
  assert.deepEqual([...slugs].sort(), originals.map((poll) => poll.slug).sort());

  const mine = await (await fetch(`${baseUrl}/api/polls/mine?limit=2`, { headers: { Cookie: owner.cookie } })).json();
  const wrongOwner = await fetch(`${baseUrl}/api/polls/mine?cursor=${mine.nextCursor}`, { headers: { Cookie: other.cookie } });
  assert.equal(wrongOwner.status, 400);
  const nextMine = await fetch(`${baseUrl}/api/polls/mine?limit=2&cursor=${mine.nextCursor}`, { headers: { Cookie: owner.cookie } });
  assert.equal(nextMine.headers.get("cache-control"), "private, no-store");
  assert.equal((await nextMine.json()).polls.length, 2);
});

test("trending cursors preserve popularity ordering and include legacy null activity dates", async () => {
  const entries = [];
  for (let index = 0; index < 5; index += 1) entries.push(await createPoll());
  await database.collection("polls").updateMany({}, { $set: { totalVotes: 5, createdAt: new Date(), lastVotedAt: null } });
  await database.collection("polls").updateOne({ _id: entries[0]._id }, { $set: { totalVotes: 10, lastVotedAt: new Date() } });
  await database.collection("polls").updateOne({ _id: entries[1]._id }, { $set: { lastVotedAt: new Date() } });
  let cursor;
  const slugs = [];
  do {
    const response = await fetch(`${baseUrl}/api/polls?trending=true&limit=1&stats=false${cursor ? `&cursor=${cursor}` : ""}`);
    assert.equal(response.status, 200);
    const page = await response.json();
    slugs.push(...page.polls.map((poll) => poll.id));
    cursor = page.nextCursor;
    assert.ok(slugs.length <= entries.length, "cursor must advance");
  } while (cursor);
  assert.equal(slugs[0], entries[0].slug);
  assert.equal(slugs[1], entries[1].slug);
  assert.equal(new Set(slugs).size, entries.length);
});

test("shared statistics exclude closed polls from active count and reuse one refresh", async () => {
  const active = await createPoll();
  const closed = await createPoll();
  const archived = await createPoll();
  const removed = await createPoll();
  await database.collection("polls").updateOne({ _id: active._id }, { $set: { totalVotes: 4, lastVotedAt: new Date() } });
  await database.collection("polls").updateOne({ _id: closed._id }, { $set: { status: "closed", totalVotes: 2 } });
  await database.collection("polls").updateOne({ _id: archived._id }, { $set: { status: "archived", totalVotes: 100 } });
  await database.collection("polls").updateOne({ _id: removed._id }, { $set: { deletedAt: new Date(), totalVotes: 100 } });
  const aggregate = Poll.aggregate;
  let scans = 0;
  Poll.aggregate = (...args) => { scans += 1; return aggregate.apply(Poll, args); };
  try {
    const values = await Promise.all(Array.from({ length: 8 }, () => getPlatformStats("stats-test")));
    assert.equal(scans, 1);
    assert.ok(values.every((value) => value.activePolls === 1 && value.totalVotes === 6 && value.categories === 6 && value.trending === 1));
    await getPlatformStats("cached-stats-test");
    assert.equal(scans, 1);

    // Simulate another serverless instance holding the refresh lease.
    await database.collection("platformstats").updateOne({ _id: "public" }, { $set: { expiresAt: new Date(0), refreshUntil: new Date(Date.now() + 15_000), refreshToken: "other-instance" } });
    assert.equal((await getPlatformStats("leased-stats-test")).stale, true);
    assert.equal(scans, 1);
  } finally { Poll.aggregate = aggregate; }
});

test("newest feed cursors use ordered indexes rather than scanning previous pages", async () => {
  const { paginatePolls } = await import("../src/services/poll-pagination.js");
  const now = Date.now();
  await Poll.insertMany(Array.from({ length: 1000 }, (_, index) => ({
    slug: `index-test-${index}`, question: "Local index test only?", category: index % 2 ? "Tech" : "Food",
    creatorId: "index-test-owner", options: [{ label: "One" }, { label: "Two" }],
    createdAt: new Date(now - index * 1000), status: index % 5 ? "active" : "archived",
  })));
  for (const filter of [
    { deletedAt: null, status: { $ne: "archived" } },
    { deletedAt: null, status: { $ne: "archived" }, category: "Tech" },
    { deletedAt: null, creatorId: "index-test-owner" },
  ]) {
    const first = await paginatePolls({ query: { limit: "100" }, filter, scope: "index-test" });
    const originalFind = Poll.find;
    let query;
    Poll.find = function (...args) { query = originalFind.apply(this, args); return query; };
    try {
      await paginatePolls({ query: { limit: "10", cursor: first.nextCursor }, filter, scope: "index-test" });
    } finally { Poll.find = originalFind; }
    const explanation = await query.clone().explain("executionStats");
    const plan = JSON.stringify(explanation.queryPlanner.winningPlan);
    assert.match(plan, /IXSCAN/, "feed should use an index");
    assert.doesNotMatch(plan, /"stage":"SORT"/, "feed should not require a blocking sort");
    assert.equal(explanation.executionStats.nReturned, 11);
    assert.ok(explanation.executionStats.totalDocsExamined <= 40, `examined ${explanation.executionStats.totalDocsExamined} records for 11 results`);
  }
});

test("account export requires recent sign-in or session-scoped MFA verification", async () => {
  const user = await createUser();
  const exportData = () => fetch(`${baseUrl}/api/account/export`, { headers: { Cookie: user.cookie } });
  assert.equal((await exportData()).status, 200);
  const sessions = { userId: { $in: [user.id, user._id] } };
  const aged = await database.collection("session").updateMany(sessions, { $set: { createdAt: new Date(Date.now() - 16 * 60_000) } });
  assert.equal(aged.modifiedCount, 1);
  const stale = await exportData();
  assert.equal(stale.status, 403);
  assert.equal((await stale.json()).code, "REAUTH_REQUIRED");
  await database.collection("user").updateOne({ _id: user._id }, { $set: { twoFactorEnabled: true } });
  assert.equal((await exportData()).status, 403);
  await database.collection("session").updateMany(sessions, { $set: { mfaVerifiedAt: new Date() } });
  const verified = await exportData();
  assert.equal(verified.status, 200);
  assert.equal(verified.headers.get("cache-control"), "no-store");
  assert.equal((await verified.json()).account.id, user.id);
  const context = await auth.$context;
  const otherSession = await context.internalAdapter.createSession(user.id, false);
  const signed = `${otherSession.token}.${await makeSignature(otherSession.token, secret)}`;
  const otherDevice = await fetch(`${baseUrl}/api/account/export`, { headers: { Cookie: `better-auth.session_token=${encodeURIComponent(signed)}` } });
  assert.equal(otherDevice.status, 403, "verification must not carry over to another device");
});

test("private vote lookup is scoped to the account or signed guest cookie", async () => {
  const owner = await createUser();
  const other = await createUser();
  const poll = await createPoll();
  const path = `/api/polls/${poll.slug}`;
  const optionId = String(poll.options[0]._id);
  assert.equal((await post(`${path}/votes`, owner.cookie, { optionId })).status, 200);
  const lookup = (cookie = "", query = "") => fetch(`${baseUrl}${path}/my-vote${query}`, { headers: { Cookie: cookie } });
  const own = await lookup(owner.cookie);
  assert.equal(own.headers.get("cache-control"), "private, no-store");
  assert.match(own.headers.get("vary"), /Cookie/);
  assert.deepEqual(await own.json(), { optionId });
  assert.deepEqual(await (await lookup(other.cookie, `?userId=${owner.id}`)).json(), { optionId: null });

  const guest = await lookup();
  const cookieHeader = guest.headers.get("set-cookie");
  assert.match(cookieHeader, /HttpOnly/);
  assert.match(cookieHeader, /SameSite=Lax/);
  assert.deepEqual(await guest.json(), { optionId: null });
  const guestCookie = cookieHeader.split(";", 1)[0];
  const guestOption = String(poll.options[1]._id);
  const requests = await Promise.all(Array.from({ length: 4 }, () => post(`${path}/votes`, guestCookie, { optionId: guestOption })));
  assert.ok(requests.every((response) => response.status === 200));
  assert.deepEqual(await (await lookup(guestCookie)).json(), { optionId: guestOption });
  assert.deepEqual(await (await lookup()).json(), { optionId: null });
  assert.deepEqual(await (await lookup(owner.cookie)).json(), { optionId });
  assert.equal((await Poll.findById(poll._id)).totalVotes, 2);
  await Poll.updateOne({ _id: poll._id }, { $set: { deletedAt: new Date() } });
  assert.equal((await lookup(owner.cookie)).status, 404);
});

test("same-choice retries survive closure but cannot change a vote or reveal removed polls", async () => {
  const user = await createUser();
  const poll = await createPoll();
  const path = `/api/polls/${poll.slug}/votes`;
  const body = { optionId: String(poll.options[0]._id) };
  const first = await post(path, user.cookie, body);
  assert.equal(first.status, 200);
  const saved = await Poll.findById(poll._id).lean();
  for (const status of ["active", "closed", "archived"]) {
    await Poll.updateOne({ _id: poll._id }, { $set: { status } });
    const retried = await post(path, user.cookie, body);
    assert.equal(retried.status, 200);
    assert.equal((await retried.json()).replayed, true);
  }
  assert.equal((await post(path, user.cookie, { optionId: String(poll.options[1]._id) })).status, 409);
  const result = await Poll.findById(poll._id);
  assert.equal(result.totalVotes, 1);
  assert.equal(result.lastVotedAt.getTime(), saved.lastVotedAt.getTime());
  assert.equal(await VoteReceipt.countDocuments({ pollSlug: poll.slug }), 1);
  await Poll.updateOne({ _id: poll._id }, { $set: { deletedAt: new Date() } });
  assert.equal((await post(path, user.cookie, body)).status, 404);
});

test("simultaneous conflicting choices accept only one immutable vote", async () => {
  const user = await createUser();
  const poll = await createPoll();
  const responses = await Promise.all(poll.options.map((option) => post(`/api/polls/${poll.slug}/votes`, user.cookie, { optionId: String(option._id) })));
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
  const saved = await Poll.findById(poll._id);
  assert.equal(saved.totalVotes, 1);
  assert.equal(saved.options.reduce((sum, option) => sum + option.votes, 0), 1);
  assert.equal(await VoteReceipt.countDocuments({ pollSlug: poll.slug }), 1);
});
