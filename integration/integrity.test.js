import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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

function latch() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function reached(promise) {
  let timer;
  try {
    await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Expected concurrent request did not reach its gate")), 5000);
    })]);
  } finally { clearTimeout(timer); }
}

// Pause a real request after middleware authorized it, without mocking the
// database result. The pending transaction must see/retry actual concurrent changes.
async function pauseIdentityRead(userId) {
  const { default: User } = await import("../src/models/AuthUser.js");
  const original = User.findOne;
  const entered = latch();
  const release = latch();
  let used = false;
  User.findOne = function (...args) {
    const query = original.apply(this, args);
    if (!used && args[0]?._id?.$in?.some((id) => String(id) === userId)) {
      used = true;
      const lean = query.lean;
      query.lean = async function (...options) {
        entered.resolve();
        await release.promise;
        return lean.apply(this, options);
      };
    }
    return query;
  };
  return { entered: entered.promise, resume: () => release.resolve(), restore() { User.findOne = original; release.resolve(); } };
}

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

function command(path, user, key, body = {}, method = "POST") {
  return fetch(`${baseUrl}${path}`, {
    method, headers: { "Content-Type": "application/json", Origin: "http://localhost:3000", Cookie: user.cookie, "Idempotency-Key": key },
    body: JSON.stringify(body),
  });
}

const pollInput = { question: "Which option do you prefer?", category: "Tech", options: ["One", "Two"] };

test("simultaneous create commands commit one poll and isolate the same key by account", async () => {
  const owner = await createUser();
  const key = "create-command-concurrent-001";
  const responses = await Promise.all(Array.from({ length: 4 }, () => command("/api/polls", owner, key, pollInput)));
  for (const response of responses) assert.equal(response.status, 201, await response.clone().text());
  const polls = await Promise.all(responses.map(async (response) => (await response.json()).poll));
  assert.equal(new Set(polls.map((poll) => poll.id)).size, 1);
  assert.equal(responses.filter((response) => response.headers.get("Idempotency-Replayed") === "true").length, 3);
  assert.equal(await Poll.countDocuments({}), 1);
  for (const poll of polls) {
    assert.equal(poll.creatorId, undefined);
    assert.equal(poll._id, undefined);
  }
  const other = await createUser();
  const response = await command("/api/polls", other, key, pollInput);
  assert.equal(response.status, 201);
  assert.notEqual((await response.json()).poll.id, polls[0].id);
  assert.equal(await database.collection("commandreceipts").countDocuments({}), 2);
});

test("command fingerprints accept reordered fields, reject changed data and validate keys", async () => {
  const owner = await createUser();
  const key = "create-command-canonical-001";
  assert.equal((await command("/api/polls", owner, key, pollInput)).status, 201);
  const reordered = await command("/api/polls", owner, key, { options: pollInput.options, category: "Tech", question: pollInput.question });
  assert.equal(reordered.status, 201);
  assert.equal(reordered.headers.get("Idempotency-Replayed"), "true");
  const conflict = await command("/api/polls", owner, key, { ...pollInput, category: "Food" });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).code, "COMMAND_CONFLICT");
  assert.equal((await command("/api/polls", owner, "short", pollInput)).status, 400);
  assert.equal(await Poll.countDocuments({}), 1);
  const receipt = await database.collection("commandreceipts").findOne({});
  assert.deepEqual(Object.keys(receipt.result), ["pollSlug"]);
  assert.equal(JSON.stringify(receipt).includes(pollInput.question), false);
  assert.equal(JSON.stringify(receipt).includes(key), false);
});

test("receipt failures roll back business writes and permit a safe retry", async () => {
  const owner = await createUser();
  const { default: Receipt } = await import("../src/models/CommandReceipt.js");
  const create = Receipt.create;
  try {
    Receipt.create = async () => { throw new Error("Injected command receipt failure"); };
    assert.equal((await command("/api/polls", owner, "create-command-rollback-001", pollInput)).status, 500);
    assert.equal(await Poll.countDocuments({}), 0);
    assert.equal(await Receipt.countDocuments({}), 0);
  } finally { Receipt.create = create; }
  assert.equal((await command("/api/polls", owner, "create-command-rollback-001", pollInput)).status, 201);
  assert.equal(await Poll.countDocuments({}), 1);
});

test("a failed staff receipt insert rolls back both content changes and their audit", async () => {
  const staff = await createUser("moderator");
  await enrollFactor(staff);
  const poll = await createPoll();
  const { default: Receipt } = await import("../src/models/CommandReceipt.js");
  const create = Receipt.create;
  const path = `/api/moderation/polls/${poll.slug}`;
  const body = { ...pollInput, category: "Food", note: "Correct the category", expectedRevision: 0 };
  try {
    Receipt.create = async () => { throw new Error("Injected staff receipt failure"); };
    assert.equal((await command(path, staff, "moderation-command-rollback", body, "PATCH")).status, 500);
    assert.equal((await Poll.findById(poll._id)).category, "Tech");
    assert.equal(await ModerationAction.countDocuments({}), 0);
    assert.equal(await Receipt.countDocuments({}), 0);
  } finally { Receipt.create = create; }
  assert.equal((await command(path, staff, "moderation-command-rollback", body, "PATCH")).status, 200);
  assert.equal(await ModerationAction.countDocuments({}), 1);
});

test("command expiry is enforced without waiting for TTL and deleted polls cannot be resurrected by replay", async () => {
  const owner = await createUser();
  const key = "create-command-expiry-001";
  const first = await command("/api/polls", owner, key, pollInput);
  const original = (await first.json()).poll;
  await database.collection("commandreceipts").updateOne({ actorId: owner.id }, { $set: { expiresAt: new Date(0) } });
  const second = await command("/api/polls", owner, key, pollInput);
  const replacement = (await second.json()).poll;
  assert.notEqual(original.id, replacement.id);
  assert.equal(second.headers.get("Idempotency-Replayed"), "false");
  await Poll.updateOne({ slug: replacement.id }, { $set: { deletedAt: new Date() } });
  assert.equal((await command("/api/polls", owner, key, pollInput)).status, 404);
  assert.equal(await Poll.countDocuments({}), 2);
});

test("staff note replays require current role, MFA and session and never duplicate the audit", async () => {
  const staff = await createUser("moderator");
  await enrollFactor(staff);
  const poll = await createPoll();
  const report = await Report.create({ pollSlug: poll.slug, reporterKey: "test-reporter", reason: "spam" });
  const path = `/api/moderation/reports/${report.id}/notes`;
  const key = "moderation-command-note-001";
  const body = { note: "Reviewed the reported content" };
  const results = await Promise.all(Array.from({ length: 4 }, () => command(path, staff, key, body)));
  for (const response of results) assert.equal(response.status, 201, await response.clone().text());
  assert.equal(await ModerationAction.countDocuments({}), 1);
  assert.equal(await database.collection("commandreceipts").countDocuments({}), 1);
  await database.collection("session").updateMany({ userId: staff._id }, { $set: { mfaVerifiedAt: new Date(0) } });
  assert.equal((await command(path, staff, key, body)).status, 403);
  await database.collection("session").updateMany({ userId: staff._id }, { $set: { mfaVerifiedAt: new Date() } });
  await database.collection("user").updateOne({ _id: staff._id }, { $set: { role: "user" } });
  assert.equal((await command(path, staff, key, body)).status, 403);
  await database.collection("user").updateOne({ _id: staff._id }, { $set: { role: "moderator" } });
  await database.collection("session").deleteMany({ userId: staff._id });
  assert.equal((await command(path, staff, key, body)).status, 403);
  assert.equal(await ModerationAction.countDocuments({}), 1);
});

test("every moderation command mapping replays without repeating its changes or audit", async () => {
  const admin = await createUser("admin");
  await enrollFactor(admin);
  const owner = await createUser();
  const poll = await createPoll(owner.id);
  const report = await Report.create({ pollSlug: poll.slug, reporterKey: "mapping-reporter", reason: "spam" });
  const reportPath = `/api/moderation/reports/${report.id}`;
  const commands = [
    [`/api/moderation/polls/${poll.slug}`, "PATCH", { question: poll.question, category: "Food", options: ["One", "Two"], note: "Correct the poll category", expectedRevision: 0 }],
    [reportPath, "PATCH", { status: "dismissed", note: "No content violation found" }],
    [`${reportPath}/notes`, "POST", { note: "Keep the review context" }],
    [reportPath, "PATCH", { status: "pending", note: "Reopen for content review" }],
    [`${reportPath}/poll`, "PATCH", { question: poll.question, category: "Tech", options: ["One", "Two"], note: "Correct the category again", expectedRevision: 1 }],
    [reportPath, "PATCH", { status: "pending", note: "New policy evidence received" }],
    [`${reportPath}/suspend-owner`, "POST", { note: "Repeated policy violations" }],
    [`${reportPath}/remove-poll`, "POST", { note: "Remove the reported content" }],
    [`/api/moderation/users/${owner.id}/role`, "PATCH", { role: "moderator" }],
    [`/api/moderation/users/${owner.id}/suspend`, "POST", { note: "Repeated policy violations" }],
    [`/api/moderation/users/${owner.id}/reactivate`, "POST", { note: "Independent review completed" }],
  ];
  for (const [index, [path, method, body]] of commands.entries()) {
    const key = `moderation-command-mapping-${index}`;
    const first = await command(path, admin, key, body, method);
    assert.ok(first.ok, `${path}: ${await first.clone().text()}`);
    const count = await ModerationAction.countDocuments({});
    const repeated = await command(path, admin, key, body, method);
    assert.equal(repeated.status, first.status, await repeated.clone().text());
    assert.equal(repeated.headers.get("Idempotency-Replayed"), "true");
    assert.deepEqual(await repeated.json(), await first.json(), path);
    assert.equal(await ModerationAction.countDocuments({}), count, path);
  }
  assert.equal(await database.collection("commandreceipts").countDocuments({}), commands.length);
});

test("replaying an old role command does not overwrite a newer decision or revive a deleted account", async () => {
  const admin = await createUser("admin");
  await enrollFactor(admin);
  const target = await createUser();
  const path = `/api/moderation/users/${target.id}/role`;
  const key = "moderation-command-role-001";
  assert.equal((await command(path, admin, key, { role: "moderator" }, "PATCH")).status, 200);
  assert.equal((await command(path, admin, "moderation-command-role-002", { role: "user" }, "PATCH")).status, 200);
  const repeated = await command(path, admin, key, { role: "moderator" }, "PATCH");
  assert.equal(repeated.status, 200);
  assert.equal((await repeated.json()).user.role, "user");
  assert.equal(await ModerationAction.countDocuments({}), 2);
  // A real deletion removes references in other actors' command receipts.
  const session = await (await auth.$context).internalAdapter.createSession(target.id, false);
  target.cookie = `better-auth.session_token=${encodeURIComponent(`${session.token}.${await makeSignature(session.token, secret)}`)}`;
  assert.equal((await post("/api/account/delete", target.cookie, { confirmation: "DELETE" })).status, 204);
  assert.equal(await database.collection("commandreceipts").countDocuments({ "result.userId": target.id }), 0);
  assert.equal((await command(path, admin, key, { role: "moderator" }, "PATCH")).status, 404);
  assert.equal(await database.collection("user").countDocuments({ _id: target._id }), 0);
});

test("account export omits private command material and deletion removes authored receipts", async () => {
  const owner = await createUser();
  const key = "create-command-privacy-001";
  assert.equal((await command("/api/polls", owner, key, pollInput)).status, 201);
  const response = await fetch(`${baseUrl}/api/account/export`, { headers: { Cookie: owner.cookie } });
  assert.equal(response.status, 200);
  const exported = await response.json();
  assert.equal(exported.recentCommands.length, 1);
  assert.deepEqual(Object.keys(exported.recentCommands[0]).sort(), ["createdAt", "expiresAt", "operation"]);
  assert.equal(JSON.stringify(exported).includes(key), false);
  assert.equal((await post("/api/account/delete", owner.cookie, { confirmation: "DELETE" })).status, 204);
  assert.equal(await database.collection("commandreceipts").countDocuments({ actorId: owner.id }), 0);
});

test("a browser command cannot silently switch accounts between preparation and submission", async () => {
  const owner = await createUser();
  const response = await fetch(`${baseUrl}/api/polls`, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: owner.cookie,
      "Idempotency-Key": "create-command-account-change", "X-Command-Actor": "previous-account" },
    body: JSON.stringify(pollInput),
  });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, "ACCOUNT_CHANGED");
  assert.equal(await Poll.countDocuments({}), 0);
});

test("owner and staff editors reject stale drafts without overwriting newer content or creating audits", async () => {
  const owner = await createUser();
  const staff = await createUser("moderator");
  await enrollFactor(staff);
  const poll = await createPoll(owner.id);
  const ownerPath = `/api/polls/${poll.slug}`;
  const staffPath = `/api/moderation/polls/${poll.slug}`;
  const base = { question: poll.question, options: ["One", "Two"] };
  const first = await command(ownerPath, owner, "owner-content-revision-first", { ...base, category: "Food", expectedRevision: 0 }, "PATCH");
  assert.equal(first.status, 200, await first.clone().text());
  assert.equal((await first.json()).poll.contentRevision, 1);
  const staleOwner = await command(ownerPath, owner, "owner-content-revision-stale", { ...base, category: "Career", expectedRevision: 0 }, "PATCH");
  assert.equal(staleOwner.status, 409);
  assert.equal((await staleOwner.json()).code, "POLL_CHANGED");
  const staleStaff = await command(staffPath, staff, "staff-content-revision-stale", { ...base, category: "Education", note: "Correct the category", expectedRevision: 0 }, "PATCH");
  assert.equal(staleStaff.status, 409);
  assert.equal((await staleStaff.json()).code, "POLL_CHANGED");
  assert.equal(await ModerationAction.countDocuments({}), 0);
  let current = await Poll.findById(poll._id);
  assert.equal(current.category, "Food");
  assert.equal(current.contentRevision, 1);
  const staffEdit = await command(staffPath, staff, "staff-content-revision-current", { ...base, category: "Education", note: "Correct the category", expectedRevision: 1 }, "PATCH");
  assert.equal(staffEdit.status, 200, await staffEdit.clone().text());
  assert.equal((await staffEdit.json()).poll.contentRevision, 2);
  assert.equal((await command(ownerPath, owner, "owner-content-revision-after-staff", { ...base, category: "Career", expectedRevision: 1 }, "PATCH")).status, 409);
  current = await Poll.findById(poll._id);
  assert.equal(current.category, "Education");
  assert.equal(current.contentRevision, 2);
  assert.equal(await ModerationAction.countDocuments({}), 1);
  const missing = await command(ownerPath, owner, "owner-content-revision-missing", { ...base, category: "Career" }, "PATCH");
  assert.equal(missing.status, 400);
});

test("simultaneous staff edits from one revision commit only one winner", async () => {
  const staff = await createUser("moderator");
  await enrollFactor(staff);
  const poll = await createPoll();
  const path = `/api/moderation/polls/${poll.slug}`;
  const edits = ["Food", "Career"].map((category, index) => command(path, staff,
    `staff-content-revision-race-${index}`, { question: poll.question, category,
      options: ["One", "Two"], note: "Independent content review", expectedRevision: 0 }, "PATCH"));
  const responses = await Promise.all(edits);
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
  const loser = responses.find((response) => response.status === 409);
  assert.equal((await loser.json()).code, "POLL_CHANGED");
  assert.equal(await ModerationAction.countDocuments({}), 1);
  assert.equal((await Poll.findById(poll._id)).contentRevision, 1);
});

test("reported edits reject stale revisions without resolving a report", async () => {
  const staff = await createUser("moderator");
  await enrollFactor(staff);
  const poll = await createPoll();
  const report = await Report.create({ pollSlug: poll.slug, reporterKey: "stale-report-test", reason: "spam" });
  const direct = await command(`/api/moderation/polls/${poll.slug}`, staff,
    "staff-direct-before-report-edit", { question: poll.question, category: "Food", options: ["One", "Two"],
      note: "Correct the category", expectedRevision: 0 }, "PATCH");
  assert.equal(direct.status, 200);
  const reported = await command(`/api/moderation/reports/${report.id}/poll`, staff,
    "staff-reported-stale-revision", { question: poll.question, category: "Education", options: ["One", "Two"],
      note: "Review after another edit", expectedRevision: 0 }, "PATCH");
  assert.equal(reported.status, 409);
  assert.equal((await reported.json()).code, "POLL_CHANGED");
  assert.equal((await Report.findById(report._id)).status, "pending");
  assert.equal(await ModerationAction.countDocuments({}), 1);
});

test("legacy polls without a revision accept one guarded edit and gain revision one", async () => {
  const owner = await createUser();
  const poll = await createPoll(owner.id);
  await database.collection("polls").updateOne({ _id: poll._id }, { $unset: { contentRevision: "" } });
  const path = `/api/polls/${poll.slug}`;
  const body = { question: poll.question, options: ["One", "Two"], category: "Food", expectedRevision: 0 };
  const response = await command(path, owner, "owner-legacy-content-revision", body, "PATCH");
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal((await response.json()).poll.contentRevision, 1);
  assert.equal((await command(path, owner, "owner-legacy-content-stale", body, "PATCH")).status, 409);
});

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
  for (const admin of admins) await enrollFactor(admin);
  const results = await Promise.allSettled(admins.map((admin) => withDatabaseTransaction((session) => setAuthUserRole(admin.id, "user", { session }))));
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(await database.collection("user").countDocuments({ role: "admin" }), 1);
});

test("an unusable backup administrator cannot authorize deletion, demotion or suspension", async () => {
  const { suspendAuthUser } = await import("../src/services/user-admin.js");
  const admin = await createUser("admin");
  await enrollFactor(admin);
  const backup = await createUser("admin");
  await enrollFactor(backup);
  const factor = await database.collection("twoFactor").findOne({ userId: { $in: [backup.id, backup._id] } });
  const poll = await createPoll(admin.id);
  for (const state of ["unverified", "unenrolled", "banned", "wrong-role", "missing-factor", "empty-factor"]) {
    await database.collection("user").updateOne({ _id: backup._id }, { $set: {
      role: state === "wrong-role" ? "moderator" : "admin", emailVerified: state !== "unverified",
      banned: state === "banned", twoFactorEnabled: state !== "unenrolled",
    } });
    await database.collection("twoFactor").deleteOne({ _id: factor._id });
    if (state !== "missing-factor") await database.collection("twoFactor").insertOne({ ...factor, secret: state === "empty-factor" ? "" : factor.secret });
    const deletion = await post("/api/account/delete", admin.cookie, { confirmation: "DELETE" });
    assert.equal(deletion.status, 409, `${state}: ${await deletion.text()}`);
    await assert.rejects(withDatabaseTransaction((session) => setAuthUserRole(admin.id, "user", { session })), { status: 409 });
    await assert.rejects(withDatabaseTransaction((session) => suspendAuthUser(admin.id, "Local safeguard check", { session })), { status: 409 });
    const kept = await database.collection("user").findOne({ _id: admin._id });
    assert.equal(kept.role, "admin");
    assert.equal(kept.banned, false);
    assert.equal((await Poll.findById(poll._id)).deletedAt, null);
  }
  await database.collection("twoFactor").replaceOne({ _id: factor._id }, factor);
  const deletion = await post("/api/account/delete", admin.cookie, { confirmation: "DELETE" });
  assert.equal(deletion.status, 204, await deletion.text());
  assert.equal(await database.collection("user").countDocuments({ _id: admin._id }), 0);
  assert.equal(await database.collection("user").countDocuments({ _id: backup._id }), 1);
});

test("backup administrator checks support legacy ID links and exclude the departing account", async () => {
  const { assertAdminWillRemain, lockAdminChanges } = await import("../src/services/user-admin.js");
  const admin = await createUser("admin");
  await enrollFactor(admin);
  const check = () => withDatabaseTransaction(async (session) => {
    await lockAdminChanges(session);
    const user = await database.collection("user").findOne({ _id: admin._id }, { session });
    await assertAdminWillRemain(user, { session });
  });
  await assert.rejects(check(), { status: 409 });
  const backup = await createUser("admin");
  await enrollFactor(backup);
  const user = await database.collection("user").findOne({ _id: backup._id });
  const factor = await database.collection("twoFactor").findOne({ userId: { $in: [backup.id, backup._id] } });
  let previousId = backup._id;
  for (const [userId, factorUserId] of [[backup._id, backup.id], [backup.id, backup._id], ["legacy-backup", "legacy-backup"]]) {
    await database.collection("user").deleteOne({ _id: previousId });
    await database.collection("user").insertOne({ ...user, _id: userId, role: "moderator,admin" });
    await database.collection("twoFactor").updateOne({ _id: factor._id }, { $set: { userId: factorUserId } });
    await check();
    previousId = userId;
  }
});

test("concurrent recovery and administrator deletion leave an enrolled administrator", async () => {
  const admin = await createUser("admin");
  const backup = await createUser("admin");
  await enrollFactor(admin);
  await enrollFactor(backup);
  const recovery = await startRecovery(backup);
  const [approval, deletion] = await Promise.all([
    post(`/api/moderation/recovery/${recovery.requestId}/approve`, admin.cookie, approveBody),
    post("/api/account/delete", admin.cookie, { confirmation: "DELETE" }),
  ]);
  if (approval.status === 200) {
    assert.equal(deletion.status, 409, await deletion.text());
    assert.equal(await ModerationAction.countDocuments({ action: "factor_recovered" }), 1);
  } else {
    assert.ok([401, 403].includes(approval.status), await approval.text());
    assert.equal(deletion.status, 204, await deletion.text());
    assert.equal(await ModerationAction.countDocuments({ action: "factor_recovered" }), 0);
  }
  const remaining = await database.collection("user").find({ role: "admin", banned: false, emailVerified: true, twoFactorEnabled: true }).toArray();
  assert.equal(remaining.length, 1);
  assert.ok(await database.collection("twoFactor").findOne({ userId: { $in: [remaining[0]._id, String(remaining[0]._id)] } }));
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

async function enrollFactor(user) {
  const enrollment = await post("/api/account/security/enable", user.cookie);
  assert.equal(enrollment.status, 200, await enrollment.clone().text());
  const { backupCodes } = await enrollment.json();
  const { idCandidates } = await import("../src/services/user-admin.js");
  const record = await database.collection("twoFactor").findOne({ userId: { $in: idCandidates(user.id) } });
  const context = await auth.$context;
  const code = await createOTP(await symmetricDecrypt({ key: context.secretConfig, data: record.secret })).totp();
  const verified = await post("/api/account/security/verify", user.cookie, { code });
  assert.equal(verified.status, 200, await verified.clone().text());
  user.cookie = updatedCookie(verified, user.cookie);
  return backupCodes;
}

async function startRecovery(user) {
  const result = await post("/api/account/security/recovery", user.cookie, { confirmation: "RECOVER" });
  assert.equal(result.status, 200, await result.clone().text());
  return (await result.json()).recovery;
}

const approveBody = { identityConfirmed: true, note: "Verified in person through a previously established contact." };

test("replacement recovery codes are encrypted, single-use and consume one session-scoped verification", async () => {
  const user = await createUser("admin");
  const previous = await enrollFactor(user);
  const context = await auth.$context;
  await context.internalAdapter.createSession(user.id, false);
  const responses = await Promise.all(Array.from({ length: 2 }, () => post("/api/account/security/recovery-codes", user.cookie, { confirmation: "REPLACE" })));
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 403]);
  const result = await responses.find((response) => response.status === 200).json();
  assert.equal(result.backupCodes.length, 10);
  assert.equal(new Set(result.backupCodes).size, 10);
  const factor = await database.collection("twoFactor").findOne({});
  assert.ok(!factor.backupCodes.includes(result.backupCodes[0]));
  assert.deepEqual(JSON.parse(await symmetricDecrypt({ key: context.secretConfig, data: factor.backupCodes })), result.backupCodes);
  assert.equal(await database.collection("session").countDocuments({}), 1);
  assert.equal((await post("/api/account/security/verify", user.cookie, { code: previous[0], backup: true })).status, 401);
  assert.equal((await post("/api/account/security/verify", user.cookie, { code: result.backupCodes[0], backup: true })).status, 200);
  assert.equal((await post("/api/account/security/verify", user.cookie, { code: result.backupCodes[0], backup: true })).status, 401);
});

test("lost-factor requests require fresh sign-in, not possession of the lost factor, and can be cancelled", async () => {
  const user = await createUser("moderator");
  await enrollFactor(user);
  await database.collection("session").updateMany({}, { $unset: { mfaVerifiedAt: "" }, $set: { createdAt: new Date(Date.now() - 16 * 60_000) } });
  assert.equal((await post("/api/account/security/recovery", user.cookie, { confirmation: "RECOVER" })).status, 403);
  await database.collection("session").updateMany({}, { $set: { createdAt: new Date() } });
  const recovery = await startRecovery(user);
  assert.deepEqual(await startRecovery(user), recovery);
  assert.equal(await database.collection("recoveryrequests").countDocuments({}), 1);
  const status = await fetch(`${baseUrl}/api/account/security`, { headers: { Cookie: user.cookie } });
  const body = await status.json();
  assert.deepEqual(body.recovery, recovery);
  assert.equal(body.verified, false);
  assert.equal(JSON.stringify(body).includes("factorFingerprint"), false);
  assert.equal((await post("/api/account/security/recovery/cancel", user.cookie)).status, 200);
  assert.equal(await database.collection("recoveryrequests").countDocuments({}), 0);
  assert.equal(await database.collection("twoFactor").countDocuments({}), 1);
});

test("only another freshly verified administrator can approve recovery, preserving roles and revoking every target session", async () => {
  const target = await createUser("admin");
  await enrollFactor(target);
  const recovery = await startRecovery(target);
  const path = `/api/moderation/recovery/${recovery.requestId}/approve`;
  assert.equal((await post(path, target.cookie, approveBody)).status, 403);
  const moderator = await createUser("moderator");
  await enrollFactor(moderator);
  assert.equal((await post(path, moderator.cookie, approveBody)).status, 403);
  const administrator = await createUser("admin");
  assert.equal((await post(path, administrator.cookie, approveBody)).status, 403);
  await enrollFactor(administrator);
  assert.equal((await post(path, administrator.cookie, { note: approveBody.note })).status, 400);
  const listing = await fetch(`${baseUrl}/api/moderation/recovery`, { headers: { Cookie: administrator.cookie } });
  const listed = await listing.json();
  assert.equal(listed.requests[0].requestId, recovery.requestId);
  assert.equal(JSON.stringify(listed).includes("factorFingerprint"), false);
  const response = await post(path, administrator.cookie, approveBody);
  assert.equal(response.status, 200, await response.clone().text());
  const updated = await database.collection("user").findOne({ _id: target._id });
  assert.equal(updated.role, "admin");
  assert.equal(updated.twoFactorEnabled, false);
  const { idCandidates } = await import("../src/services/user-admin.js");
  assert.equal(await database.collection("session").countDocuments({ userId: { $in: idCandidates(target.id) } }), 0);
  assert.equal((await post("/api/account/security/verify", target.cookie, { code: "123456" })).status, 401);
  assert.equal(await ModerationAction.countDocuments({ action: "factor_recovered", targetUserId: target.id }), 1);
  // A successful retry must not reset a newly enrolled factor.
  const context = await auth.$context;
  const fresh = await context.internalAdapter.createSession(target.id, false);
  target.cookie = `better-auth.session_token=${encodeURIComponent(`${fresh.token}.${await makeSignature(fresh.token, secret)}`)}`;
  const queue = await fetch(`${baseUrl}/api/moderation/reports`, { headers: { Cookie: target.cookie } });
  assert.equal(queue.status, 403);
  await enrollFactor(target);
  const replay = await post(path, administrator.cookie, approveBody);
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).replayed, true);
  assert.equal((await database.collection("user").findOne({ _id: target._id })).twoFactorEnabled, true);
  assert.equal(await ModerationAction.countDocuments({ action: "factor_recovered" }), 1);
});

test("recovery approval rolls back every change when its audit fails and rejects expired or changed factors", async () => {
  const target = await createUser("moderator");
  await enrollFactor(target);
  const administrator = await createUser("admin");
  await enrollFactor(administrator);
  const recovery = await startRecovery(target);
  const path = `/api/moderation/recovery/${recovery.requestId}/approve`;
  const originalCreate = ModerationAction.create;
  try {
    ModerationAction.create = async () => { throw new Error("Injected recovery audit failure"); };
    assert.equal((await post(path, administrator.cookie, approveBody)).status, 500);
  } finally { ModerationAction.create = originalCreate; }
  assert.equal((await database.collection("user").findOne({ _id: target._id })).twoFactorEnabled, true);
  assert.equal(await database.collection("twoFactor").countDocuments({}), 2);
  assert.equal((await database.collection("recoveryrequests").findOne({ _id: target.id })).status, "pending");
  const { idCandidates } = await import("../src/services/user-admin.js");
  await database.collection("twoFactor").updateOne({ userId: { $in: idCandidates(target.id) } }, { $set: { secret: "changed-factor-for-test" } });
  assert.equal((await post(path, administrator.cookie, approveBody)).status, 409);
  await database.collection("recoveryrequests").updateOne({ _id: target.id }, { $set: { expiresAt: new Date(0) } });
  assert.equal((await post(path, administrator.cookie, approveBody)).status, 404);
});

test("recovery code replacement rolls back ciphertext and session revocation together", async () => {
  const user = await createUser();
  const previous = await enrollFactor(user);
  const context = await auth.$context;
  await context.internalAdapter.createSession(user.id, false);
  const { default: RecoveryRequest } = await import("../src/models/RecoveryRequest.js");
  const original = RecoveryRequest.deleteOne;
  try {
    RecoveryRequest.deleteOne = async () => { throw new Error("Injected recovery cancellation failure"); };
    assert.equal((await post("/api/account/security/recovery-codes", user.cookie, { confirmation: "REPLACE" })).status, 500);
  } finally { RecoveryRequest.deleteOne = original; }
  assert.equal(await database.collection("session").countDocuments({}), 2);
  assert.equal((await post("/api/account/security/verify", user.cookie, { code: previous[0], backup: true })).status, 200);
});

test("simultaneous recovery approvals produce exactly one factor reset and audit record", async () => {
  const target = await createUser();
  await enrollFactor(target);
  const recovery = await startRecovery(target);
  const administrators = [await createUser("admin"), await createUser("admin")];
  for (const administrator of administrators) await enrollFactor(administrator);
  const responses = await Promise.all(administrators.map((administrator) => post(`/api/moderation/recovery/${recovery.requestId}/approve`, administrator.cookie, approveBody)));
  assert.deepEqual(responses.map((response) => response.status), [200, 200]);
  const results = await Promise.all(responses.map((response) => response.json()));
  assert.deepEqual(results.map((result) => result.replayed).sort(), [false, true]);
  assert.equal(await ModerationAction.countDocuments({ action: "factor_recovered" }), 1);
});

test("recovery queue is paginated, excludes expired requests and rejects stale approval proof", async () => {
  const administrator = await createUser("admin");
  await enrollFactor(administrator);
  const { default: RecoveryRequest } = await import("../src/models/RecoveryRequest.js");
  const { randomUUID } = await import("node:crypto");
  await RecoveryRequest.insertMany(Array.from({ length: 28 }, (_, index) => ({
    _id: `user-${String(index).padStart(2, "0")}`, requestId: randomUUID(), status: "pending", factorFingerprint: "test-only",
    createdAt: new Date(), expiresAt: new Date(Date.now() + (index === 27 ? -1000 : 86_400_000)),
  })));
  const getQueue = (suffix = "") => fetch(`${baseUrl}/api/moderation/recovery${suffix}`, { headers: { Cookie: administrator.cookie } });
  const first = await (await getQueue()).json();
  assert.equal(first.requests.length, 25);
  const second = await (await getQueue(`?after=${first.nextCursor}`)).json();
  assert.equal(second.requests.length, 2);
  assert.equal(second.nextCursor, null);
  assert.equal(new Set([...first.requests, ...second.requests].map((row) => row.userId)).size, 27);
  assert.equal((await getQueue("?after=invalid%20cursor")).status, 400);
  await database.collection("session").updateMany({}, { $set: { mfaVerifiedAt: new Date(Date.now() - 16 * 60_000) } });
  assert.equal((await post(`/api/moderation/recovery/${first.requests[0].requestId}/approve`, administrator.cookie, approveBody)).status, 403);
});

test("account export omits recovery fingerprints and deletion clears recovery ownership", async () => {
  const user = await createUser();
  await enrollFactor(user);
  const recovery = await startRecovery(user);
  const exported = await fetch(`${baseUrl}/api/account/export`, { headers: { Cookie: user.cookie } });
  assert.equal(exported.status, 200);
  const body = await exported.json();
  assert.equal(body.recoveryRequest.requestId, recovery.requestId);
  assert.equal(JSON.stringify(body).includes("factorFingerprint"), false);
  await database.collection("recoveryrequests").insertOne({ _id: "another-owner", requestId: "another-request", approvedBy: user.id });
  assert.equal((await post("/api/account/delete", user.cookie, { confirmation: "DELETE" })).status, 204);
  assert.equal(await database.collection("recoveryrequests").findOne({ _id: user.id }), null);
  assert.equal((await database.collection("recoveryrequests").findOne({ _id: "another-owner" })).approvedBy, null);
});

async function staffGet(path, user) {
  return fetch(`${baseUrl}/api/moderation${path}`, { headers: { Cookie: user.cookie } });
}

test("report cursors reach every older report without exposing identity or embedding unbounded history", async () => {
  const staff = await createUser("moderator");
  await enrollFactor(staff);
  const poll = await createPoll();
  const reports = await Report.insertMany(Array.from({ length: 61 }, (_, index) => ({
    pollSlug: poll.slug, reporterKey: `private-${index}`, reporterUserId: `private-user-${index}`, reason: "spam",
    createdAt: new Date("2026-01-01T00:00:00Z"),
  })));
  const firstResponse = await staffGet("/reports?status=pending", staff);
  assert.equal(firstResponse.headers.get("cache-control"), "private, no-store");
  const first = await firstResponse.json();
  assert.equal(first.reports.length, 25);
  assert.ok(first.reports.every((report) => !report.reporterKey && !report.reporterUserId && !report.history));
  const seen = first.reports.map((report) => report.id);
  await Report.create({ pollSlug: poll.slug, reporterKey: "new-arrival", reason: "other" });
  let cursor = first.nextCursor;
  while (cursor) {
    const response = await staffGet(`/reports?status=pending&cursor=${cursor}`, staff);
    assert.equal(response.status, 200, await response.clone().text());
    const data = await response.json();
    seen.push(...data.reports.map((report) => report.id));
    cursor = data.nextCursor;
  }
  assert.equal(new Set(seen).size, reports.length);
  assert.deepEqual(seen, reports.map((report) => String(report._id)).reverse());
  assert.equal((await staffGet(`/reports?status=resolved&cursor=${first.nextCursor}`, staff)).status, 400);
  assert.equal((await staffGet("/reports?page=1001", staff)).status, 400);
  assert.equal((await staffGet("/reports?limit=100000", staff)).status, 400);
  assert.equal((await staffGet("/reports?cursor=invalid", staff)).status, 400);
  const forged = JSON.parse(Buffer.from(first.nextCursor, "base64url").toString("utf8"));
  forged.type = "string";
  forged.id = "not-an-object-id";
  const token = Buffer.from(JSON.stringify(forged)).toString("base64url");
  assert.equal((await staffGet(`/reports?cursor=${token}`, staff)).status, 400);
});

test("account cursors preserve tied timestamps and mixed string/ObjectId IDs and bind to search filters", async () => {
  const administrator = await createUser("admin");
  await enrollFactor(administrator);
  const users = Array.from({ length: 61 }, (_, index) => {
    const id = new ObjectId();
    return { _id: index % 2 ? id : String(id), name: `Cursor member ${index}`, email: `cursor-${index}@example.test`,
      emailVerified: true, role: "user", image: "private-image", createdAt: new Date("2026-01-01T00:00:00Z") };
  });
  await database.collection("user").insertMany(users);
  const expected = await database.collection("user").find({ name: /^Cursor member/ }).sort({ createdAt: -1, _id: -1 }).toArray();
  let cursor, firstCursor;
  const seen = [];
  do {
    const response = await staffGet(`/users?field=name&q=Cursor%20member&limit=7${cursor ? `&cursor=${cursor}` : ""}`, administrator);
    assert.equal(response.status, 200, await response.clone().text());
    const data = await response.json();
    assert.ok(data.users.every((user) => !user.image && !user.history));
    seen.push(...data.users.map((user) => user.id));
    firstCursor ||= data.nextCursor;
    cursor = data.nextCursor;
  } while (cursor);
  assert.deepEqual(seen, expected.map((user) => String(user._id)));
  assert.equal(new Set(seen).size, users.length);
  assert.equal((await staffGet(`/users?q=different&cursor=${firstCursor}`, administrator)).status, 400);
});

test("complete report, poll and account histories remain accessible beyond old caps with scoped permissions", async () => {
  const administrator = await createUser("admin");
  await enrollFactor(administrator);
  const moderator = await createUser("moderator");
  await enrollFactor(moderator);
  const member = await createUser();
  const poll = await createPoll(member.id);
  const report = await Report.create({ pollSlug: poll.slug, reporterKey: "private-reporter", reason: "spam" });
  const actions = await ModerationAction.insertMany(Array.from({ length: 257 }, (_, index) => ({
    action: "poll_edited", actorId: moderator.id, actorName: "Reviewing moderator", actorRole: "moderator",
    pollSlug: poll.slug, reportId: report._id, targetUserId: member.id, note: `Audit entry ${index}`,
    before: { category: "Tech" }, after: { category: "Social" }, createdAt: new Date("2026-01-01T00:00:00Z"),
  })));
  // Removing the subject must not make its retained audit history unreachable.
  await Poll.updateOne({ _id: poll._id }, { $set: { deletedAt: new Date(), status: "archived" } });
  for (const path of [`/reports/${report._id}/history`, `/polls/${poll.slug}/history`, `/users/${member.id}/history`, "/history"]) {
    const identity = path.startsWith("/users") || path === "/history" ? administrator : moderator;
    const ids = [];
    let cursor;
    do {
      const response = await staffGet(`${path}?limit=50${cursor ? `&cursor=${cursor}` : ""}`, identity);
      assert.equal(response.status, 200, await response.clone().text());
      assert.equal(response.headers.get("cache-control"), "private, no-store");
      const data = await response.json();
      ids.push(...data.actions.map((entry) => entry.id));
      assert.ok(data.actions.every((entry) => entry.before.category === "Tech" && entry.after.category === "Social"));
      cursor = data.nextCursor;
    } while (cursor);
    assert.deepEqual(ids, actions.map((action) => String(action._id)).reverse());
  }
  assert.equal((await staffGet("/history", moderator)).status, 403);
  assert.equal((await staffGet(`/users/${member.id}/history`, moderator)).status, 403);
  assert.equal((await staffGet(`/polls/${poll.slug}/history`, member)).status, 403);
  assert.equal((await fetch(`${baseUrl}/api/moderation/history`)).status, 403);
  const page = await (await staffGet(`/reports/${report._id}/history`, moderator)).json();
  assert.equal((await staffGet(`/polls/${poll.slug}/history?cursor=${page.nextCursor}`, moderator)).status, 400);
});

test("staff cursor queries seek ordered indexes instead of scanning earlier pages", async () => {
  const { paginateStaff } = await import("../src/services/staff-pagination.js");
  const { default: AuthUser } = await import("../src/models/AuthUser.js");
  const now = Date.now();
  const reportId = new ObjectId();
  await Report.insertMany(Array.from({ length: 1000 }, (_, index) => ({
    pollSlug: "local-query-plan", reporterKey: `local-${index}`, reason: "spam", createdAt: new Date(now - index * 1000),
  })));
  await ModerationAction.insertMany(Array.from({ length: 1000 }, (_, index) => ({
    action: "note_added", actorId: "local-staff", actorName: "Local staff", actorRole: "moderator",
    pollSlug: "local-query-plan", reportId, targetUserId: "local-user", createdAt: new Date(now - index * 1000),
  })));
  await database.collection("user").insertMany(Array.from({ length: 1000 }, (_, index) => ({
    name: "Local query plan", email: `plan-${index}@example.test`, createdAt: new Date(now - index * 1000),
  })));
  for (const [model, filter] of [[Report, { status: "pending" }], [AuthUser, {}], [ModerationAction, {}], [ModerationAction, { reportId }], [ModerationAction, { pollSlug: "local-query-plan" }], [ModerationAction, { targetUserId: "local-user" }]]) {
    const first = await paginateStaff(model, { query: { limit: "50" }, filter, scope: "query-plan" });
    const originalFind = model.find;
    let query;
    model.find = function (...args) { query = originalFind.apply(this, args); return query; };
    try {
      await paginateStaff(model, { query: { cursor: first.nextCursor, limit: "10" }, filter, scope: "query-plan" });
    } finally { model.find = originalFind; }
    const explanation = await query.clone().explain("executionStats");
    const plan = JSON.stringify(explanation.queryPlanner.winningPlan);
    assert.match(plan, /IXSCAN/);
    assert.doesNotMatch(plan, /"stage":"SORT"/);
    assert.equal(explanation.executionStats.nReturned, 11);
    assert.ok(explanation.executionStats.totalDocsExamined <= 40, `${model.modelName} examined ${explanation.executionStats.totalDocsExamined} documents`);
  }
});

test("deletion rejects already-authorized poll, report and vote requests without orphaned account links", async () => {
  const { getAccountVoterKey } = await import("../src/voter.js");
  for (const kind of ["poll", "report", "vote"]) {
    const user = await createUser();
    const poll = await createPoll();
    const path = kind === "poll" ? "/api/polls" : `/api/polls/${poll.slug}/${kind === "report" ? "reports" : "votes"}`;
    const body = kind === "poll" ? { question: "A concurrent local question?", category: "Tech", options: ["One", "Two"] }
      : kind === "report" ? { reason: "spam", details: "Local race check" } : { optionId: String(poll.options[0]._id) };
    const gate = await pauseIdentityRead(user.id);
    const pending = post(path, user.cookie, body);
    try {
      await reached(gate.entered);
      const deleted = await post("/api/account/delete", user.cookie, { confirmation: "DELETE" });
      assert.equal(deleted.status, 204, await deleted.text());
      gate.resume();
      const result = await pending;
      assert.equal(result.status, 401, `${kind}: ${await result.text()}`);
      assert.equal(await Poll.countDocuments({ creatorId: user.id }), 0);
      assert.equal(await Report.countDocuments({ reporterUserId: user.id }), 0);
      assert.equal(await VoteReceipt.countDocuments({ voterKey: getAccountVoterKey(user.id) }), 0);
      assert.equal((await Poll.findById(poll._id)).totalVotes, 0);
    } finally { gate.restore(); await pending.catch(() => {}); }
  }
});

test("writes that lock first commit before deletion, and deletion retries then cleans every new link", async () => {
  const { default: User } = await import("../src/models/AuthUser.js");
  const { getAccountVoterKey } = await import("../src/voter.js");
  for (const [kind, model] of [["poll", Poll], ["report", Report], ["vote", VoteReceipt]]) {
    const user = await createUser();
    const poll = await createPoll();
    const path = kind === "poll" ? "/api/polls" : `/api/polls/${poll.slug}/${kind === "report" ? "reports" : "votes"}`;
    const body = kind === "poll" ? { question: "A local committed question?", category: "Tech", options: ["One", "Two"] }
      : kind === "report" ? { reason: "spam" } : { optionId: String(poll.options[0]._id) };
    const originalCreate = model.create;
    const originalUpdate = User.updateOne;
    const entered = latch(), release = latch(), conflict = latch();
    let held = false;
    model.create = async function (...args) {
      if (!held) { held = true; entered.resolve(); await release.promise; }
      return originalCreate.apply(this, args);
    };
    const pending = post(path, user.cookie, body);
    let deletion;
    try {
      await reached(entered.promise); // Both identity documents are already write-locked.
      User.updateOne = async function (...args) {
        try { return await originalUpdate.apply(this, args); }
        catch (error) { if (error.code === 112) conflict.resolve(); throw error; }
      };
      deletion = post("/api/account/delete", user.cookie, { confirmation: "DELETE" });
      await reached(conflict.promise); // A genuine MongoDB write conflict, not a mocked error.
      release.resolve();
      const written = await pending;
      assert.equal(written.status, kind === "vote" ? 200 : 201, await written.clone().text());
      const deleted = await deletion;
      assert.equal(deleted.status, 204, await deleted.text());
      assert.equal(await database.collection("user").countDocuments({ _id: user._id }), 0);
      assert.equal(await database.collection("session").countDocuments({ userId: { $in: [user.id, user._id] } }), 0);
      assert.equal(await Poll.countDocuments({ creatorId: user.id }), 0);
      assert.equal(await Report.countDocuments({ reporterUserId: user.id }), 0);
      assert.equal(await VoteReceipt.countDocuments({ voterKey: getAccountVoterKey(user.id) }), 0);
      if (kind === "poll") {
        const { poll: created } = await written.json();
        const removed = await Poll.findOne({ slug: created.id });
        assert.equal(removed.creatorId, null);
        assert.ok(removed.deletedAt);
      }
      if (kind === "vote") {
        assert.equal((await Poll.findById(poll._id)).totalVotes, 1);
        assert.match((await VoteReceipt.findOne({ pollSlug: poll.slug })).voterKey, /^deleted:/);
      }
    } finally {
      release.resolve();
      model.create = originalCreate;
      User.updateOne = originalUpdate;
      await Promise.allSettled([pending, deletion].filter(Boolean));
    }
  }
});

test("session revocation stops an already-authorized poll creation", async () => {
  const user = await createUser();
  const context = await auth.$context;
  const other = await context.internalAdapter.createSession(user.id, false);
  const otherCookie = `better-auth.session_token=${encodeURIComponent(`${other.token}.${await makeSignature(other.token, secret)}`)}`;
  const gate = await pauseIdentityRead(user.id);
  const pending = post("/api/polls", user.cookie, { question: "A stale session question?", category: "Tech", options: ["One", "Two"] });
  try {
    await reached(gate.entered);
    assert.equal((await post("/api/account/security/sessions/revoke", otherCookie, { others: true })).status, 200);
    gate.resume();
    assert.equal((await pending).status, 401);
    assert.equal(await Poll.countDocuments({ creatorId: user.id }), 0);
    assert.equal(await database.collection("session").countDocuments({}), 1);
  } finally { gate.restore(); await pending.catch(() => {}); }
});

test("staff content writes recheck role, suspension, session and MFA after middleware", async () => {
  for (const change of ["role", "ban", "session", "factor", "proof"]) {
    const staff = await createUser("moderator");
    await enrollFactor(staff);
    const poll = await createPoll();
    const gate = await pauseIdentityRead(staff.id);
    const pending = fetch(`${baseUrl}/api/moderation/polls/${poll.slug}`, {
      method: "PATCH", headers: { "Content-Type": "application/json", Cookie: staff.cookie },
      body: JSON.stringify({ question: poll.question, category: "Food", options: ["One", "Two"], note: "Local concurrency check", expectedRevision: 0 }),
    });
    try {
      await reached(gate.entered);
      const userFilter = { _id: staff._id };
      const sessionFilter = { userId: { $in: [staff.id, staff._id] } };
      if (change === "role") await database.collection("user").updateOne(userFilter, { $set: { role: "user" } });
      if (change === "ban") await database.collection("user").updateOne(userFilter, { $set: { banned: true } });
      if (change === "factor") await database.collection("user").updateOne(userFilter, { $set: { twoFactorEnabled: false } });
      if (change === "session") await database.collection("session").deleteMany(sessionFilter);
      if (change === "proof") await database.collection("session").updateMany(sessionFilter, { $set: { mfaVerifiedAt: new Date(0) } });
      gate.resume();
      const response = await pending;
      assert.equal(response.status, change === "session" ? 401 : 403, `${change}: ${await response.text()}`);
      assert.equal((await Poll.findById(poll._id)).category, "Tech");
      assert.equal(await ModerationAction.countDocuments({ actorId: staff.id }), 0);
    } finally { gate.restore(); await pending.catch(() => {}); }
  }
});

test("administrator-only writes cannot proceed with stale administrator authority", async () => {
  const actor = await createUser("admin");
  await enrollFactor(actor);
  const target = await createUser();
  const gate = await pauseIdentityRead(actor.id);
  const pending = fetch(`${baseUrl}/api/moderation/users/${target.id}/role`, {
    method: "PATCH", headers: { "Content-Type": "application/json", Cookie: actor.cookie }, body: JSON.stringify({ role: "admin" }),
  });
  try {
    await reached(gate.entered);
    // Simulates an independently changed database principal while the request is in flight.
    await database.collection("user").updateOne({ _id: actor._id }, { $set: { role: "moderator" } });
    gate.resume();
    assert.equal((await pending).status, 403);
    assert.equal((await database.collection("user").findOne({ _id: target._id })).role, "user");
    assert.equal(await ModerationAction.countDocuments({ actorId: actor.id }), 0);
  } finally { gate.restore(); await pending.catch(() => {}); }
});

test("identity revision writes roll back when the poll insert fails", async () => {
  const user = await createUser();
  const original = Poll.create;
  Poll.create = async () => { throw new Error("Injected poll insert failure"); };
  try {
    const response = await post("/api/polls", user.cookie, { question: "A rollback question?", category: "Tech", options: ["One", "Two"] });
    assert.equal(response.status, 500);
    assert.equal(await Poll.countDocuments({}), 0);
    assert.equal((await database.collection("user").findOne({ _id: user._id })).securityRevision, undefined);
    assert.equal((await database.collection("session").findOne({ userId: { $in: [user.id, user._id] } })).securityRevision, undefined);
  } finally { Poll.create = original; }
});

async function fillRateBucket(prefix, identity, windowMs, count) {
  const start = Math.floor(Date.now() / windowMs) * windowMs;
  // Include the next window so an actual clock boundary cannot make a test flaky.
  for (const windowStart of [start, start + windowMs]) {
    await database.collection("ratebuckets").updateOne(
      { _id: `${prefix}:${createHash("sha256").update(identity).digest("hex")}:${windowStart}` },
      { $set: { count, expiresAt: new Date(windowStart + windowMs * 2) } }, { upsert: true },
    );
  }
}

test("public read limits cover GET and HEAD, preserve liveness and do not leak cached denials", async () => {
  const address = "198.51.100.10";
  await fillRateBucket("read", `ip:${address}`, 60_000, 600);
  for (const method of ["GET", "HEAD"]) {
    const response = await fetch(`${baseUrl}/api/polls?stats=false`, { method, headers: { "X-Forwarded-For": address } });
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.ok(Number(response.headers.get("retry-after")) > 0);
  }
  assert.equal((await fetch(`${baseUrl}/api/health/live`, { headers: { "X-Forwarded-For": address } })).status, 200);
  assert.equal((await fetch(`${baseUrl}/api/polls?stats=false`, { headers: { "X-Forwarded-For": "198.51.100.11" } })).status, 200);
});

test("account export quota follows the account across networks and leaves other accounts available", async () => {
  const user = await createUser();
  const other = await createUser();
  for (let index = 0; index < 3; index += 1) {
    const response = await fetch(`${baseUrl}/api/account/export`, { headers: { Cookie: user.cookie, "X-Forwarded-For": `198.51.100.${20 + index}` } });
    assert.equal(response.status, 200, await response.text());
  }
  // Pin a full bucket even if the three exports crossed an hourly boundary.
  await fillRateBucket("export", `user:${user.id}`, 3_600_000, 3);
  const denied = await fetch(`${baseUrl}/api/account/export`, { headers: { Cookie: user.cookie, "X-Forwarded-For": "198.51.100.25" } });
  assert.equal(denied.status, 429);
  assert.equal(denied.headers.get("cache-control"), "private, no-store");
  const allowed = await fetch(`${baseUrl}/api/account/export`, { headers: { Cookie: other.cookie, "X-Forwarded-For": "198.51.100.25" } });
  assert.equal(allowed.status, 200);
  assert.equal((await allowed.json()).account.id, other.id);
});

test("voting and reporting identify the real account before consuming participant quotas", async () => {
  const { getAccountVoterKey } = await import("../src/voter.js");
  const user = await createUser();
  const other = await createUser();
  const poll = await createPoll();
  const participant = `voter:${getAccountVoterKey(user.id)}`;
  await fillRateBucket("write", participant, 60_000, 30);
  await fillRateBucket("report", participant, 3_600_000, 5);
  const send = (action, cookie, address) => fetch(`${baseUrl}/api/polls/${poll.slug}/${action}`, {
    method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json", "X-Forwarded-For": address },
    body: JSON.stringify(action === "votes" ? { optionId: String(poll.options[0]._id) } : { reason: "spam" }),
  });
  for (const action of ["votes", "reports"]) {
    assert.equal((await send(action, user.cookie, "198.51.100.30")).status, 429);
    assert.equal((await send(action, user.cookie, "198.51.100.31")).status, 429);
  }
  assert.equal(await VoteReceipt.countDocuments({}), 0);
  assert.equal(await Report.countDocuments({}), 0);
  assert.equal((await send("votes", other.cookie, "198.51.100.31")).status, 200);
  assert.equal((await send("reports", other.cookie, "198.51.100.31")).status, 201);
  assert.equal((await Poll.findById(poll._id)).totalVotes, 1);
});

test("first guest submission uses the same signed identity for its limiter and receipt", async () => {
  const poll = await createPoll();
  const result = await post(`/api/polls/${poll.slug}/votes`, null, { optionId: String(poll.options[0]._id) });
  assert.equal(result.status, 200, await result.clone().text());
  const cookies = result.headers.getSetCookie().filter((cookie) => cookie.startsWith("wdyt_voter="));
  assert.equal(cookies.length, 1);
  const cookie = cookies[0].split(";", 1)[0];
  const lookup = await fetch(`${baseUrl}/api/polls/${poll.slug}/my-vote`, { headers: { Cookie: cookie } });
  assert.equal((await lookup.json()).optionId, String(poll.options[0]._id));
  const receipt = await VoteReceipt.findOne({ pollSlug: poll.slug }).lean();
  const digest = createHash("sha256").update(`voter:${receipt.voterKey}`).digest("hex");
  assert.equal(await database.collection("ratebuckets").countDocuments({ _id: { $regex: `^write:${digest}:` }, count: 1 }), 1);
});

test("independent limiter instances enforce one shared allowance under concurrent MongoDB writes", async () => {
  const { createLimiter } = await import("../src/rate-limit.js");
  const timestamp = Date.now();
  const options = { prefix: "concurrency-test", windowMs: 60_000, rules: [{ key: () => "one-identity", max: 7 }],
    message: "Slow down", cacheSize: 0, now: () => timestamp };
  const instances = [createLimiter(options), createLimiter(options)];
  const statuses = await Promise.all(Array.from({ length: 40 }, async (_, index) => {
    const response = { statusCode: 200, set() {}, status(code) { this.statusCode = code; return this; }, json() {} };
    await instances[index % 2]({}, response, () => {});
    return response.statusCode;
  }));
  assert.equal(statuses.filter((status) => status === 200).length, 7);
  assert.equal(statuses.filter((status) => status === 429).length, 33);
  assert.equal(await database.collection("ratebuckets").countDocuments({ _id: /^concurrency-test:/ }), 1);
  assert.equal((await database.collection("ratebuckets").findOne({ _id: /^concurrency-test:/ })).count, 40);
});

test("network write rejection runs before JSON parsing or guest identity allocation", async () => {
  const address = "198.51.100.50";
  await fillRateBucket("write-network", `ip:${address}`, 60_000, 300);
  const response = await fetch(`${baseUrl}/api/polls/anything/votes`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Forwarded-For": address }, body: "invalid-json",
  });
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal(await VoteReceipt.countDocuments({}), 0);
  assert.equal(await database.collection("ratebuckets").countDocuments({ _id: /^write:/ }), 0);
});
