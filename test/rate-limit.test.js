import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import RateBucket from "../src/models/RateBucket.js";
import { createLimiter, limitAccountReads, limitPollCreation, limitReports, limitWrites, networkIdentity } from "../src/rate-limit.js";
import { getVoterKey } from "../src/voter.js";

const original = RateBucket.findOneAndUpdate;
let counts, calls, timestamp;
beforeEach(() => {
  counts = new Map(); calls = []; timestamp = 1_000;
  RateBucket.findOneAndUpdate = async (filter, update, options) => {
    calls.push({ filter, update, options });
    assert.equal(update.$inc.count, 1);
    assert.equal(options.maxTimeMS, 2000);
    const count = (counts.get(filter._id) || 0) + 1;
    counts.set(filter._id, count);
    return { count };
  };
});
afterEach(() => { RateBucket.findOneAndUpdate = original; });

function limiter(overrides = {}) {
  return createLimiter({ prefix: "test", windowMs: 60_000,
    rules: [{ key: (request) => request.ip, max: 2 }], message: "Slow down",
    now: () => timestamp, ...overrides });
}

async function attempt(limit, request = { ip: "192.0.2.1" }) {
  const response = {
    headers: {}, cookies: [], statusCode: 200, allowed: false,
    set(name, value) { this.headers[name] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    cookie(name, value) { this.cookies.push(`${name}=${encodeURIComponent(value)}`); },
  };
  await limit(request, response, (error) => { assert.ifError(error); response.allowed = true; });
  return response;
}

test("shared counters reject excess requests with private retry headers and bounded expiry", async () => {
  const limit = limiter();
  assert.equal((await attempt(limit)).allowed, true);
  assert.equal((await attempt(limit)).allowed, true);
  const denied = await attempt(limit);
  assert.equal(denied.statusCode, 429);
  assert.equal(denied.allowed, false);
  assert.equal(denied.headers["Retry-After"], "59");
  assert.equal(denied.headers["RateLimit-Limit"], "2");
  assert.equal(denied.headers["RateLimit-Remaining"], "0");
  assert.equal(denied.headers["Cache-Control"], "private, no-store");
  assert.equal(calls[0].update.$setOnInsert.expiresAt.getTime(), 120_000);
  assert.ok(!calls[0].filter._id.includes("192.0.2.1"));
});

test("rotating IPv6 addresses share a /64 quota while separate networks stay independent", async () => {
  const first = "2001:db8:abcd:42::1";
  const rotated = "2001:0db8:abcd:0042:ffff::9";
  const other = "2001:db8:abcd:43::1";
  assert.equal(networkIdentity({ ip: first }), networkIdentity({ ip: rotated }));
  assert.notEqual(networkIdentity({ ip: first }), networkIdentity({ ip: other }));
  assert.equal(networkIdentity({ ip: "::ffff:192.0.2.1" }), networkIdentity({ ip: "192.0.2.1" }));
  assert.equal(networkIdentity({ ip: "not-an-address" }), "ip:unknown");

  const limit = limiter({ rules: [{ key: networkIdentity, max: 1 }] });
  assert.equal((await attempt(limit, { ip: first })).allowed, true);
  assert.equal((await attempt(limit, { ip: rotated })).statusCode, 429);
  assert.equal((await attempt(limit, { ip: other })).allowed, true);
});

test("cached rejection avoids all counter writes and expires at the window boundary", async () => {
  const limit = limiter({ rules: [{ key: () => "network", max: 100 }, { key: () => "account", max: 1 }] });
  await attempt(limit);
  assert.equal((await attempt(limit)).statusCode, 429);
  const before = calls.length;
  assert.equal((await attempt(limit)).statusCode, 429);
  assert.equal(calls.length, before);
  timestamp = 60_000;
  assert.equal((await attempt(limit)).allowed, true);
  assert.equal(calls.length, before + 2);
});

test("cache eviction and independent instances never turn a shared rejection into an allowance", async () => {
  const first = limiter({ cacheSize: 1, rules: [{ key: (request) => request.ip, max: 1 }] });
  const second = limiter({ cacheSize: 0, rules: [{ key: (request) => request.ip, max: 1 }] });
  for (const ip of ["192.0.2.1", "192.0.2.2"]) {
    assert.equal((await attempt(first, { ip })).allowed, true);
    assert.equal((await attempt(first, { ip })).statusCode, 429);
  }
  const before = calls.length;
  assert.equal((await attempt(first)).statusCode, 429);
  assert.equal(calls.length, before + 1); // The first entry was evicted, not trusted.
  assert.equal((await attempt(second)).statusCode, 429);
});

test("simultaneous first-bucket insertion retries only duplicate-key errors", async () => {
  const options = [];
  RateBucket.findOneAndUpdate = async (_filter, _update, settings) => {
    options.push(settings);
    if (options.length === 1) throw Object.assign(new Error("Duplicate bucket"), { code: 11000 });
    return { count: 2 };
  };
  assert.equal((await attempt(limiter())).allowed, true);
  assert.deepEqual(options.map((value) => value.upsert), [true, false]);
});

test("database failures and invalid counter results fail closed without exposing errors", async () => {
  for (const value of [null, { count: NaN }, { count: 0 }, new Error("private-database-address")]) {
    RateBucket.findOneAndUpdate = async () => { if (value instanceof Error) throw value; return value; };
    const response = await attempt(limiter());
    assert.equal(response.statusCode, 503);
    assert.equal(response.allowed, false);
    assert.equal(response.headers["Retry-After"], "5");
    assert.ok(!JSON.stringify(response).includes("private-database-address"));
  }
});

test("write quota follows the account across networks without sharing another account's quota", async () => {
  const user = { user: { id: "unit-write-user" } };
  for (let index = 0; index < 30; index += 1) {
    assert.equal((await attempt(limitWrites, { ip: `192.0.2.${index + 1}`, auth: user })).allowed, true);
  }
  assert.equal((await attempt(limitWrites, { ip: "192.0.2.99", auth: user })).statusCode, 429);
  assert.equal((await attempt(limitWrites, { ip: "192.0.2.99", auth: { user: { id: "other-unit-user" } } })).allowed, true);
});

test("guest limiting and voting reuse one signed identity within the request", async () => {
  let cookie;
  for (let index = 0; index < 5; index += 1) {
    const request = { ip: "192.0.2.100", headers: { cookie } };
    const response = await attempt(limitReports, request);
    assert.equal(response.allowed, true);
    const key = getVoterKey(request, response, null);
    assert.equal(getVoterKey(request, response, null), key);
    assert.equal(response.cookies.length, index === 0 ? 1 : 0);
    cookie ||= response.cookies[0];
  }
  assert.equal((await attempt(limitReports, { ip: "192.0.2.101", headers: { cookie } })).statusCode, 429);
  assert.equal((await attempt(limitReports, { ip: "192.0.2.100", headers: {} })).allowed, true);
});

test("network cap blocks identity cycling before allocating another identity bucket", async () => {
  const limit = limiter({ rules: [
    { key: () => "network", max: 2 }, { key: (request) => request.identity, max: 1 },
  ] });
  for (const identity of ["one", "two"]) assert.equal((await attempt(limit, { identity })).allowed, true);
  assert.equal((await attempt(limit, { identity: "three" })).statusCode, 429);
  assert.equal(counts.size, 3); // Network and the first two identities only.
});

test("account-aware creation limits allow different users on a shared network", async () => {
  const request = { ip: "192.0.2.110", auth: { user: { id: "unit-creator" } } };
  for (let index = 0; index < 10; index += 1) assert.equal((await attempt(limitPollCreation, request)).allowed, true);
  assert.equal((await attempt(limitPollCreation, request)).statusCode, 429);
  assert.equal((await attempt(limitPollCreation, { ...request, auth: { user: { id: "other-creator" } } })).allowed, true);
});

test("account read limits apply to GET and HEAD but do not consume write quota", async () => {
  const request = { ip: "192.0.2.120", auth: { user: { id: "unit-reader" } }, method: "POST" };
  assert.equal((await attempt(limitAccountReads, request)).allowed, true);
  assert.equal(calls.length, 0);
  assert.equal((await attempt(limitAccountReads, { ...request, method: "HEAD" })).allowed, true);
  assert.equal((await attempt(limitAccountReads, { ...request, method: "GET" })).allowed, true);
  assert.equal(calls.length, 2);
});
