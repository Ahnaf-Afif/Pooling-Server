import "dotenv/config";

import { closeDatabases, connectDatabase, getMongoDatabase } from "../src/db.js";
import ModerationAction from "../src/models/ModerationAction.js";
import Poll from "../src/models/Poll.js";
import RateBucket from "../src/models/RateBucket.js";
import Report from "../src/models/Report.js";
import VoteReceipt from "../src/models/VoteReceipt.js";

const apply = process.argv.includes("--apply");

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

async function prepareChangedIndexes() {
  const reportIndexes = await Report.collection.indexes();
  if (reportIndexes.some((index) => index.name === "pollSlug_1_reporterKey_1")) {
    console.log("reports: replace permanent reporter uniqueness with pending-only uniqueness");
    if (apply) await Report.collection.dropIndex("pollSlug_1_reporterKey_1");
  }

  const receiptIndexes = await VoteReceipt.collection.indexes();
  const receiptCreatedAt = receiptIndexes.find((index) => index.name === "createdAt_1");
  if (receiptCreatedAt?.expireAfterSeconds !== undefined) {
    console.log("votereceipts: preserve receipts for the lifetime of their poll");
    if (apply) await VoteReceipt.collection.dropIndex("createdAt_1");
  }
}

async function syncMongooseIndexes() {
  const models = [Poll, VoteReceipt, Report, ModerationAction, RateBucket];
  for (const model of models) {
    console.log(`${model.collection.collectionName}: ensure declared indexes`);
    if (apply) await model.createIndexes();
  }
}

async function syncNativeIndexes() {
  await assertNoDuplicates("user", ["email"]);
  await assertNoDuplicates("session", ["token"]);
  await assertNoDuplicates("account", ["providerId", "accountId"]);
  await assertNoDuplicates("rateLimit", ["key"]);

  for (const [collectionName, indexes] of Object.entries(nativeIndexes)) {
    const collection = getMongoDatabase().collection(collectionName);
    for (const [keys, options] of indexes) {
      console.log(`${collectionName}: ensure ${options.name}`);
      if (apply) await collection.createIndex(keys, options);
    }
  }
}

try {
  await connectDatabase();
  await prepareChangedIndexes();
  await syncMongooseIndexes();
  await syncNativeIndexes();
  console.log(apply ? "Database indexes synchronized" : "Dry run complete; add --apply to change indexes");
} finally {
  await closeDatabases();
}
