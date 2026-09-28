import { createHash } from "node:crypto";
import ipaddr from "ipaddr.js";

import RateBucket from "./models/RateBucket.js";
import { getVoterKey } from "./voter.js";

const MINUTE = 60_000;
const hash = (value) => createHash("sha256").update(value).digest("hex");
export function networkIdentity(request) {
  if (!request.ip || !ipaddr.isValid(request.ip)) return "ip:unknown";
  const address = ipaddr.parse(request.ip);
  if (address.kind() === "ipv4") return `ip:${address.toString()}`;
  if (address.isIPv4MappedAddress()) return `ip:${address.toIPv4Address().toString()}`;
  // One IPv6 network bucket for rotating privacy addresses within a /64.
  return `ip6:${address.parts.slice(0, 4).map((part) => part.toString(16).padStart(4, "0")).join(":")}/64`;
}
const network = networkIdentity;
const account = (request) => `user:${request.auth.user.id}`;
const participant = (request, response) => `voter:${getVoterKey(request, response, request.auth)}`;
const reads = ["GET", "HEAD"];

// Exported so tests can exercise independent server instances sharing MongoDB.
export function createLimiter({ prefix, windowMs, rules, message, methods, cacheSize = 5000, now = Date.now }) {
  // Cache only rejections: another instance must still consult shared counters
  // before allowing traffic. Eviction cannot grant extra requests.
  const blocked = new Map();
  return async function limit(request, response, next) {
    if (methods && !methods.includes(request.method)) return next();
    const timestamp = now();
    const windowStart = Math.floor(timestamp / windowMs) * windowMs;
    const remaining = Math.max(1, Math.ceil((windowStart + windowMs - timestamp) / 1000));
    function reject(rule) {
      response.set("Cache-Control", "private, no-store");
      response.set("RateLimit-Limit", String(rule.max));
      response.set("RateLimit-Remaining", "0");
      response.set("RateLimit-Reset", String(remaining));
      response.set("Retry-After", String(remaining));
      return response.status(429).json({ message });
    }
    try {
      const buckets = [];
      for (const rule of rules) {
        const key = `${prefix}:${hash(rule.key(request, response))}:${windowStart}`;
        if ((blocked.get(key) || 0) > timestamp) return reject(rule);
        blocked.delete(key);
        buckets.push({ rule, key });
      }
      // Broad network limits run first, before allocating per-identity buckets.
      for (const { rule, key } of buckets) {
        const filter = { _id: key };
        const update = { $inc: { count: 1 }, $setOnInsert: { expiresAt: new Date(windowStart + windowMs * 2) } };
        const options = { upsert: true, returnDocument: "after", maxTimeMS: 2000 };
        let bucket;
        try { bucket = await RateBucket.findOneAndUpdate(filter, update, options); }
        catch (error) {
          // A simultaneous first request may have inserted the unique bucket.
          if (error.code !== 11000) throw error;
          bucket = await RateBucket.findOneAndUpdate(filter, update, { ...options, upsert: false });
        }
        if (!Number.isSafeInteger(bucket?.count) || bucket.count < 1) throw new Error("Rate-limit counter unavailable");
        if (bucket.count > rule.max) {
          if (blocked.size >= cacheSize) blocked.delete(blocked.keys().next().value);
          if (cacheSize > 0) blocked.set(key, windowStart + windowMs);
          return reject(rule);
        }
      }
      return next();
    } catch (error) {
      // Never permit an expensive request when its shared protection is down.
      console.warn(JSON.stringify({ level: "warn", event: "rate_limit_unavailable", requestId: request.id, error: error.name }));
      response.set("Cache-Control", "private, no-store");
      response.set("Retry-After", "5");
      return response.status(503).json({ message: "Request protection is temporarily unavailable. Please try again shortly." });
    }
  };
}

export const limitReads = createLimiter({
  prefix: "read", windowMs: MINUTE, methods: reads,
  rules: [{ key: network, max: 600 }],
  message: "Too many requests from this network. Please try again in a minute.",
});

export const limitAccountReads = createLimiter({
  prefix: "account-read", windowMs: MINUTE, methods: reads,
  rules: [{ key: account, max: 120 }],
  message: "Too many account requests. Please try again in a minute.",
});

// Runs before authentication/body parsing, including on anonymous endpoints.
export const limitWriteNetwork = createLimiter({
  prefix: "write-network", windowMs: MINUTE, methods: ["POST", "PATCH", "PUT", "DELETE"],
  rules: [{ key: network, max: 300 }],
  message: "Too many requests from this network. Please try again in a minute.",
});

export const limitWrites = createLimiter({
  prefix: "write", windowMs: MINUTE,
  rules: [{ key: participant, max: 30 }],
  message: "Too many requests. Please try again in a minute.",
});

export const limitPollCreation = createLimiter({
  prefix: "create", windowMs: 24 * 60 * MINUTE,
  rules: [{ key: network, max: 100 }, { key: account, max: 10 }],
  message: "The poll creation limit has been reached for this account or network. Try again after the daily window resets.",
});

export const limitReports = createLimiter({
  prefix: "report", windowMs: 60 * MINUTE,
  rules: [{ key: network, max: 50 }, { key: participant, max: 5 }],
  message: "Too many reports. Please try again later.",
});

export const limitExports = createLimiter({
  prefix: "export", windowMs: 60 * MINUTE,
  rules: [{ key: network, max: 30 }, { key: account, max: 3 }],
  message: "You can export your account three times per hour. Please try again later.",
});

export const limitSecurityAttempts = createLimiter({
  prefix: "security", windowMs: 15 * MINUTE,
  rules: [{ key: network, max: 100 }, { key: account, max: 10 }],
  message: "Too many security attempts. Try again in 15 minutes.",
});
