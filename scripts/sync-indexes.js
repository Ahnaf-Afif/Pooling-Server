import { pathToFileURL } from "node:url";

import { closeDatabases, connectDatabase, getMongoDatabase } from "../src/db.js";
import ModerationAction from "../src/models/ModerationAction.js";
import Poll from "../src/models/Poll.js";
import RateBucket from "../src/models/RateBucket.js";
import Report from "../src/models/Report.js";
import VoteReceipt from "../src/models/VoteReceipt.js";
import AdminGuard from "../src/models/AdminGuard.js";
import PlatformStats from "../src/models/PlatformStats.js";
import RecoveryRequest from "../src/models/RecoveryRequest.js";

const models = [Poll, VoteReceipt, Report, ModerationAction, RateBucket, AdminGuard, PlatformStats, RecoveryRequest];
const migrationId = "2026-09-staff-history-v6";

const nativeIndexes = {
  user: [
    [{ email: 1 }, { name: "user_email_unique", unique: true }],
    [{ createdAt: -1, _id: -1 }, { name: "user_created_desc" }],
    [{ role: 1, banned: 1 }, { name: "user_role_status" }],
  ],
  session: [
    [{ token: 1 }, { name: "session_token_unique", unique: true }],
    [{ userId: 1 }, { name: "session_user" }],
    [{ expiresAt: 1 }, { name: "session_expiry", expireAfterSeconds: 0 }],
  ],
  account: [
    [{ providerId: 1, accountId: 1 }, { name: "account_provider_unique", unique: true }],
    [{ userId: 1 }, { name: "account_user" }],
  ],
  twoFactor: [
    [{ userId: 1 }, { name: "two_factor_user_unique", unique: true }],
  ],
  verification: [
    [{ identifier: 1 }, { name: "verification_identifier" }],
    [{ expiresAt: 1 }, { name: "verification_expiry", expireAfterSeconds: 0 }],
  ],
  rateLimit: [
    [{ key: 1 }, { name: "auth_rate_limit_key_unique", unique: true }],
    [{ lastRequest: 1 }, { name: "auth_rate_limit_last_request" }],
  ],
};

async function assertNoDuplicates(collectionName, fields) {
  const collection = getMongoDatabase().collection(collectionName);
  const id = Object.fromEntries(fields.map((field) => [field, `$${field}`]));
  const duplicates = await collection.aggregate([
    { $group: { _id: id, count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
    { $limit: 1 },
  ]).hasNext();
  if (duplicates) throw new Error(`Cannot create a unique ${collectionName} index until duplicate records are resolved`);
}

async function listIndexes(collection) {
  try { return await collection.indexes(); }
  catch (error) { if (error.code === 26) return []; throw error; }
}

async function prepareChangedIndexes(apply) {
  const reportIndexes = await listIndexes(Report.collection);
  if (reportIndexes.some((index) => index.name === "pollSlug_1_reporterKey_1")) {
    console.log("reports: replace permanent reporter uniqueness with pending-only uniqueness");
    if (apply) {
      // Install the replacement first, keeping duplicate protection throughout.
      await Report.collection.createIndex({ pollSlug: 1, reporterKey: 1 }, {
        name: "unique_pending_reporter_per_poll", unique: true, partialFilterExpression: { status: "pending" },
      });
      await Report.collection.dropIndex("pollSlug_1_reporterKey_1");
    }
  }

  const receiptIndexes = await listIndexes(VoteReceipt.collection);
  const receiptCreatedAt = receiptIndexes.find((index) => index.name === "createdAt_1");
  if (receiptCreatedAt?.expireAfterSeconds !== undefined) {
    console.log("votereceipts: preserve receipts for the lifetime of their poll");
    if (apply) await VoteReceipt.collection.dropIndex("createdAt_1");
  }
}

async function syncMongooseIndexes(apply) {
  for (const model of models) {
    console.log(`${model.collection.collectionName}: ensure declared indexes`);
    if (apply) await model.createIndexes();
  }
}

async function checkDuplicates() {
  await assertNoDuplicates("user", ["email"]);
  await assertNoDuplicates("session", ["token"]);
  await assertNoDuplicates("account", ["providerId", "accountId"]);
  await assertNoDuplicates("twoFactor", ["userId"]);
  await assertNoDuplicates("rateLimit", ["key"]);
}

async function syncNativeIndexes(apply) {
  for (const [collectionName, indexes] of Object.entries(nativeIndexes)) {
    const collection = getMongoDatabase().collection(collectionName);
    for (const [keys, options] of indexes) {
      console.log(`${collectionName}: ensure ${options.name}`);
      if (apply) await collection.createIndex(keys, options);
    }
  }
}

export async function verifyIndexes() {
  const declarations = models.map((model) => [model.collection.collectionName, model.schema.indexes()]);
  const missing = [];
  for (const [name, indexes] of [...declarations, ...Object.entries(nativeIndexes)]) {
    const current = await listIndexes(getMongoDatabase().collection(name));
    for (const [keys, options] of indexes) {
      const match = current.find((index) => JSON.stringify(index.key) === JSON.stringify(keys)
        && Boolean(index.unique) === Boolean(options.unique)
        && index.expireAfterSeconds === options.expireAfterSeconds
        && JSON.stringify(index.partialFilterExpression) === JSON.stringify(options.partialFilterExpression));
      if (!match) missing.push(`${name}: ${JSON.stringify(keys)}`);
    }
  }
  if (missing.length) throw new Error(`Missing or mismatched required indexes:\n${missing.join("\n")}`);
}

export async function syncIndexes({ apply = false, verify = false } = {}) {
  if (verify) { await verifyIndexes(); return; }
  await checkDuplicates();
  await prepareChangedIndexes(apply);
  await syncMongooseIndexes(apply);
  await syncNativeIndexes(apply);
  if (apply) {
    await AdminGuard.updateOne({ _id: "administrators" }, { $setOnInsert: { revision: 0 } }, { upsert: true });
    await verifyIndexes();
    await getMongoDatabase().collection("migrations").updateOne(
      { _id: migrationId }, { $setOnInsert: { appliedAt: new Date() } }, { upsert: true },
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await import("dotenv/config");
  try {
    await connectDatabase();
    const apply = process.argv.includes("--apply");
    const verify = process.argv.includes("--verify");
    await syncIndexes({ apply, verify });
    console.log(verify ? "Required database indexes verified" : apply ? "Database indexes synchronized and verified" : "Dry run complete; add --apply to change indexes");
  } finally { await closeDatabases(); }
}
