import { createHash } from "node:crypto";

import RateBucket from "./models/RateBucket.js";

const WINDOW_MS = 60_000;
const MAX_WRITES = 30;

const hash = (value) => createHash("sha256").update(value).digest("hex");

async function consumeBucket(key, windowMs) {
  const now = Date.now();
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const bucket = await RateBucket.findOneAndUpdate(
    { _id: `${key}:${windowStart}` },
    { $inc: { count: 1 }, $setOnInsert: { expiresAt: new Date(windowStart + windowMs * 2) } },
    { upsert: true, returnDocument: "after" },
  );
  return { count: bucket.count, remainingMs: windowStart + windowMs - now };
}

function createLimiter({ prefix, windowMs, max, message, keys }) {
  return async function limit(request, response, next) {
    try {
      const identities = keys(request);
      const buckets = await Promise.all(
        identities.map((identity) => consumeBucket(`${prefix}:${hash(identity)}`, windowMs)),
      );
      const highestCount = Math.max(...buckets.map((bucket) => bucket.count));
      const remainingMs = Math.max(...buckets.map((bucket) => bucket.remainingMs));

      response.set("RateLimit-Limit", String(max));
      response.set("RateLimit-Remaining", String(Math.max(0, max - highestCount)));
      response.set("RateLimit-Reset", String(Math.ceil(remainingMs / 1000)));

      if (highestCount > max) {
        response.set("Retry-After", String(Math.max(1, Math.ceil(remainingMs / 1000))));
        return response.status(429).json({ message });
      }
      return next();
    } catch (error) {
      return next(error);
    }
  };
}

export const limitWrites = createLimiter({
  prefix: "write",
  windowMs: WINDOW_MS,
  max: MAX_WRITES,
  message: "Too many requests. Please try again in a minute.",
  keys: (request) => [request.ip || "unknown"],
});

export const limitPollCreation = createLimiter({
  prefix: "create",
  windowMs: 24 * 60 * 60 * 1000,
  max: 10,
  message: "You have reached today's poll creation limit.",
  keys: (request) => [
    `ip:${request.ip || "unknown"}`,
    `user:${request.auth?.user?.id || "unknown"}`,
  ],
});

export const limitReports = createLimiter({
  prefix: "report",
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: "Too many reports. Please try again later.",
  keys: (request) => [request.ip || "unknown"],
});

export const limitSecurityAttempts = createLimiter({
  prefix: "security",
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: "Too many security attempts. Try again in 15 minutes.",
  keys: (request) => [`user:${request.auth.user.id}`],
});
