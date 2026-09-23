import assert from "node:assert/strict";
import test from "node:test";

import { getVoterKey } from "../src/voter.js";

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
