import assert from "node:assert/strict";
import test from "node:test";

import { createSlug, validatePoll } from "../src/validation.js";

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

test("creates URL-safe unique slugs", () => {
  const first = createSlug("Kacchi or Tehari?");
  const second = createSlug("Kacchi or Tehari?");

  assert.match(first, /^kacchi-or-tehari-[a-f0-9]{8}$/);
  assert.notEqual(first, second);
});
