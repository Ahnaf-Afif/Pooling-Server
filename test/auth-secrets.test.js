import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAuthSecrets } from "../src/auth-secrets.js";

const previous = "previous-key-used-only-for-testing-12345";
const current = "current-key-used-only-for-testing-67890";

test("versioned secret parsing preserves order and permits version gaps", () => {
  const entries = [{ version: 3, value: current }, { version: 1, value: previous }];
  assert.deepEqual(parseAuthSecrets(JSON.stringify(entries), previous), entries);
  assert.deepEqual(parseAuthSecrets("", previous), [{ version: 1, value: previous }]);
});

test("ambiguous or malformed key rings fail without printing secret values", () => {
  for (const value of ["invalid", "null", "[]", "[null]", '[{"version":1,"value":"short"}]', JSON.stringify([{ version: 1, value: current }, { version: 1, value: previous }])]) {
    assert.throws(() => parseAuthSecrets(value, previous), (error) => {
      assert.match(error.message, /BETTER_AUTH_SECRETS/);
      assert.ok(!error.message.includes(previous));
      assert.ok(!error.message.includes(current));
      return true;
    });
  }
});
