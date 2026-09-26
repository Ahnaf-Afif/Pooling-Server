import { getMongoDatabase } from "./db.js";

const RETENTION_MS = 48 * 60 * 60 * 1000;
let nextCleanupAt = 0;

// Better Auth stores lastRequest as a numeric epoch, so MongoDB's Date TTL index
// cannot clean this collection. Opportunistically prune it once per warm instance.
export async function cleanupAuthRateLimitRecords() {
  const now = Date.now();
  if (now < nextCleanupAt) return;
  nextCleanupAt = now + 60 * 60 * 1000;
  await getMongoDatabase().collection("rateLimit").deleteMany({ lastRequest: { $lt: now - RETENTION_MS } });
}
