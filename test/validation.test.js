import assert from "node:assert/strict";
import test from "node:test";

import { contentRevisionFilter, createSlug, validatePoll } from "../src/validation.js";

test("normalizes a valid poll", () => {
  const result = validatePoll({
    question: "  Which city   do you prefer? ",
    category: "Lifestyle",
    options: [" Dhaka ", "Chattogram"],
  });

  assert.deepEqual(result.errors, []);
  assert.equal(result.value.question, "Which city do you prefer?");
  assert.deepEqual(result.value.options, ["Dhaka", "Chattogram"]);
});

test("rejects duplicates and incomplete polls", () => {
  const result = validatePoll({
    question: "No?",
    category: "Unknown",
    options: ["Same", "same"],
  });

  assert.equal(result.errors.length, 3);
});

test("rejects null and non-object poll bodies without crashing", () => {
  for (const input of [null, [], "poll"]) {
    assert.ok(validatePoll(input).errors.length > 0);
  }
});

test("creates URL-safe unique slugs", () => {
  const first = createSlug("Kacchi or Tehari?");
  const second = createSlug("Kacchi or Tehari?");

  assert.match(first, /^kacchi-or-tehari-[a-f0-9]{12}$/);
  assert.notEqual(first, second);
});

test("edits require a safe content revision and include legacy polls without one", () => {
  const poll = { question: "Which option?", category: "Tech", options: ["One", "Two"] };
  assert.match(validatePoll(poll, { editing: true }).errors[0], /content revision/);
  for (const expectedRevision of [-1, 1.5, Number.MAX_SAFE_INTEGER, "0", null]) {
    assert.ok(validatePoll({ ...poll, expectedRevision }, { editing: true }).errors.length);
  }
  assert.equal(validatePoll({ ...poll, expectedRevision: 0 }, { editing: true }).value.expectedRevision, 0);
  assert.deepEqual(contentRevisionFilter(0), { contentRevision: { $in: [0, null] } });
  assert.deepEqual(contentRevisionFilter(2), { contentRevision: 2 });
});
