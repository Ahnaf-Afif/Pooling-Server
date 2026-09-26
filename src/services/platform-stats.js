import { randomUUID } from "node:crypto";
import { CATEGORIES, TRENDING_MIN_VOTES, TRENDING_WINDOW_MS } from "../constants.js";
import PlatformStats from "../models/PlatformStats.js";
import Poll from "../models/Poll.js";

let pending;

async function refresh(requestId) {
  const now = new Date();
  const refreshToken = randomUUID();
  let cached;
  try {
    cached = await PlatformStats.findById("public").lean();
    if (cached?.stats && cached.expiresAt > now) return { ...cached.stats, stale: false };
    if (cached?.refreshUntil > now) return cached.stats ? { ...cached.stats, stale: true } : null;
    try {
      await PlatformStats.findOneAndUpdate(
        { _id: "public", $or: [{ refreshUntil: { $lte: now } }, { refreshUntil: null }] },
        { $set: { refreshToken, refreshUntil: new Date(now.getTime() + 15_000) } },
        { upsert: true, returnDocument: "after" },
      );
    } catch (error) {
      // Another instance owns the refresh lease. Never duplicate its scan.
      if (error.code === 11000) return cached?.stats ? { ...cached.stats, stale: true } : null;
      throw error;
    }
    const cutoff = new Date(now.getTime() - TRENDING_WINDOW_MS);
    const [totals] = await Poll.aggregate([
      { $match: { deletedAt: null, status: { $ne: "archived" } } },
      { $group: {
        _id: null,
        activePolls: { $sum: { $cond: [{ $eq: [{ $ifNull: ["$status", "active"] }, "active"] }, 1, 0] } },
        totalVotes: { $sum: "$totalVotes" },
        trending: { $sum: { $cond: [{ $and: [
          { $gte: ["$totalVotes", TRENDING_MIN_VOTES] },
          { $gte: [{ $ifNull: ["$lastVotedAt", "$createdAt"] }, cutoff] },
        ] }, 1, 0] } },
      } },
    ]).option({ maxTimeMS: 5000 });
    const stats = {
      activePolls: totals?.activePolls || 0, totalVotes: totals?.totalVotes || 0,
      trending: totals?.trending || 0, categories: CATEGORIES.length, asOf: now,
    };
    await PlatformStats.updateOne({ _id: "public", refreshToken }, {
      $set: { stats, expiresAt: new Date(Date.now() + 60_000), refreshUntil: new Date(0) },
      $unset: { refreshToken: "" },
    });
    return { ...stats, stale: false };
  } catch (error) {
    console.warn(JSON.stringify({ level: "warn", event: "platform_stats_failed", requestId, error: error.message }));
    await PlatformStats.updateOne({ _id: "public", refreshToken }, { $set: { refreshUntil: new Date(Date.now() + 5000) } }).catch(() => {});
    return cached?.stats ? { ...cached.stats, stale: true } : null;
  }
}

export function getPlatformStats(requestId) {
  pending ||= refresh(requestId).finally(() => { pending = null; });
  return pending;
}
