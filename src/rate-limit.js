import { createHash } from "node:crypto";

import RateBucket from "./models/RateBucket.js";

const WINDOW_MS = 60_000;
const MAX_WRITES = 30;

export async function limitWrites(request, response, next) {
  try {
    const now = Date.now();
    const windowStart = Math.floor(now / WINDOW_MS) * WINDOW_MS;
    const ipHash = createHash("sha256").update(request.ip || "unknown").digest("hex");
    const bucket = await RateBucket.findOneAndUpdate(
      { _id: `${ipHash}:${windowStart}` },
      { $inc: { count: 1 }, $setOnInsert: { expiresAt: new Date(windowStart + WINDOW_MS * 2) } },
      { upsert: true, returnDocument: "after" },
    );

    response.set("RateLimit-Limit", String(MAX_WRITES));
    response.set("RateLimit-Remaining", String(Math.max(0, MAX_WRITES - bucket.count)));
    response.set("RateLimit-Reset", String(Math.ceil((windowStart + WINDOW_MS - now) / 1000)));

    if (bucket.count > MAX_WRITES) {
      return response.status(429).json({ message: "Too many requests. Please try again in a minute." });
    }
    return next();
  } catch (error) {
    return next(error);
  }
}
