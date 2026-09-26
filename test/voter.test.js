import assert from "node:assert/strict";
import test from "node:test";

import { getAccountVoterKey, getVoterKey, getVoterSecret } from "../src/voter.js";

function responseRecorder() {
  return {
    cookieValue: null,
    cookieOptions: null,
    cookie(_name, value, options) {
      this.cookieValue = value;
      this.cookieOptions = options;
    },
  };
}

test("creates and verifies a signed anonymous voter cookie", () => {
  const firstResponse = responseRecorder();
  const firstKey = getVoterKey({ headers: {} }, firstResponse, null);
  assert.ok(firstResponse.cookieValue);
  assert.equal(firstResponse.cookieOptions.httpOnly, true);
  assert.equal(firstResponse.cookieOptions.sameSite, "lax");

  const secondResponse = responseRecorder();
  const secondKey = getVoterKey(
    { headers: { cookie: `wdyt_voter=${encodeURIComponent(firstResponse.cookieValue)}` } },
    secondResponse,
    null,
  );
  assert.equal(secondKey, firstKey);
  assert.equal(secondResponse.cookieValue, null);
});

test("uses the account identity for a signed-in voter", () => {
  const first = getVoterKey({ headers: {} }, responseRecorder(), { user: { id: "user-one" } });
  const second = getVoterKey({ headers: {} }, responseRecorder(), { user: { id: "user-one" } });
  const different = getVoterKey({ headers: {} }, responseRecorder(), { user: { id: "user-two" } });
  assert.equal(first, second);
  assert.notEqual(first, different);
});

test("malformed, tampered and non-ASCII cookies are replaced safely", () => {
  const original = responseRecorder();
  const originalKey = getVoterKey({ headers: {} }, original, null);
  const [id, signature] = original.cookieValue.split(".");
  for (const value of [
    `${id}.${"é".repeat(43)}`, `${id}.${"x".repeat(43)}`,
    `${id}.${signature}.extra`, `invalid.${signature}`, "%broken", "",
  ]) {
    const response = responseRecorder();
    const key = getVoterKey({ headers: { cookie: `wdyt_voter=${encodeURIComponent(value)}` } }, response, null);
    assert.ok(response.cookieValue);
    assert.notEqual(key, originalKey);
  }
});

test("pinning the legacy voter secret preserves receipts and cookies across auth rotation", () => {
  const saved = { ...process.env };
  try {
    process.env.NODE_ENV = "test";
    delete process.env.VOTER_SECRET;
    process.env.BETTER_AUTH_SECRET = "old-auth-secret-for-voter-migration-test-only";
    const legacyAccount = getAccountVoterKey("existing-user");
    const firstResponse = responseRecorder();
    const legacyGuest = getVoterKey({ headers: {} }, firstResponse, null);
    process.env.VOTER_SECRET = process.env.BETTER_AUTH_SECRET;
    process.env.BETTER_AUTH_SECRET = "new-auth-secret-for-voter-migration-test-only";
    process.env.NODE_ENV = "production";
    assert.equal(getAccountVoterKey("existing-user"), legacyAccount);
    const response = responseRecorder();
    assert.equal(getVoterKey({ headers: { cookie: `wdyt_voter=${firstResponse.cookieValue}` } }, response, null), legacyGuest);
    assert.equal(response.cookieValue, null);
  } finally {
    for (const name of ["NODE_ENV", "VOTER_SECRET", "BETTER_AUTH_SECRET"]) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
});

test("production cannot silently fall back to the rotating auth key", () => {
  const saved = { NODE_ENV: process.env.NODE_ENV, VOTER_SECRET: process.env.VOTER_SECRET };
  try {
    process.env.NODE_ENV = "production";
    delete process.env.VOTER_SECRET;
    assert.throws(getVoterSecret, /VOTER_SECRET is required/);
    process.env.VOTER_SECRET = "too-short";
    assert.throws(getVoterSecret, /at least 32/);
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
