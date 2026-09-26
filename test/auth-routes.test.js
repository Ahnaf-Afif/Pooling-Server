import assert from "node:assert/strict";
import { test } from "node:test";
import { auth } from "../src/auth.js";

// Real auth handler, without an HTTP listener or database. Keep the expected
// paths independent of the implementation's disabledPaths list.
test("alternate session routes cannot bypass account-security guards", async () => {
  for (const path of ["list-sessions", "revoke-session", "revoke-sessions", "revoke-other-sessions"]) {
    for (const method of ["GET", "POST"]) {
      const response = await auth.handler(new Request(`http://localhost:3000/api/auth/${path}`, {
        method,
        headers: { Origin: "http://localhost:3000", "Content-Type": "application/json" },
        ...(method === "POST" ? { body: "{}" } : {}),
      }));
      assert.equal(response.status, 404, `${method} ${path}`);
    }
  }
});
