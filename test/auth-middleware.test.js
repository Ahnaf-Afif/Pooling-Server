import assert from "node:assert/strict";
import test from "node:test";

import { requireAdmin, requireModerator } from "../src/auth-middleware.js";

async function run(middleware, role) {
  const request = {
    auth: {
      user: {
        id: "test-user",
        email: "admin-from-old-env@example.com",
        role,
        emailVerified: true,
        twoFactorEnabled: true,
      },
      session: { createdAt: new Date(), mfaVerifiedAt: new Date() },
    },
  };
  const result = { nextCalled: false, status: null, body: null };
  const response = {
    status(status) { result.status = status; return this; },
    json(body) { result.body = body; return this; },
  };
  await middleware(request, response, () => { result.nextCalled = true; });
  return { request, result };
}

test("uses the persistent session role for moderator access", async () => {
  const denied = await run(requireModerator, "user");
  assert.equal(denied.result.status, 403);
  assert.equal(denied.result.nextCalled, false);

  const allowed = await run(requireModerator, "moderator");
  assert.equal(allowed.result.nextCalled, true);
  assert.equal(allowed.request.auth.effectiveRole, "moderator");
});

test("allows only a persistent admin role into administration", async () => {
  assert.equal((await run(requireAdmin, "moderator")).result.status, 403);
  assert.equal((await run(requireAdmin, "admin")).result.nextCalled, true);
});
