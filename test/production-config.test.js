import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { productionConfigErrors } from "../src/production-config.js";
import { getClientOrigins } from "../src/config.js";

const valid = {
  MONGODB_URI: "mongodb://127.0.0.1:27017/release_check",
  BETTER_AUTH_SECRET: "auth-config-check-only-not-a-real-secret-1234",
  VOTER_SECRET: "voter-config-check-only-not-a-real-secret-1234",
  BETTER_AUTH_URL: "https://polls.test",
  CLIENT_ORIGINS: "https://polls.test",
  GOOGLE_CLIENT_ID: "fixture-client.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "fixture-provider-secret",
};

test("production configuration requires a pinned voter key, database and a complete sign-in provider", () => {
  assert.deepEqual(productionConfigErrors(valid), []);
  for (const key of ["MONGODB_URI", "BETTER_AUTH_SECRET", "VOTER_SECRET", "BETTER_AUTH_URL", "CLIENT_ORIGINS", "GOOGLE_CLIENT_SECRET"]) {
    assert.ok(productionConfigErrors({ ...valid, [key]: "" }).some((error) => error.includes(key)), key);
  }
  assert.ok(productionConfigErrors({ ...valid, GOOGLE_CLIENT_ID: "", GOOGLE_CLIENT_SECRET: "" }).some((error) => error.includes("provider")));
});

test("production configuration rejects insecure origins, implicit databases and malformed key rings without leaking values", () => {
  for (const patch of [
    { BETTER_AUTH_URL: "http://polls.test" },
    { CLIENT_ORIGINS: "https://polls.test, http://localhost:3000" },
    { CLIENT_ORIGINS: "https://another.test" },
    { BETTER_AUTH_URL: "https://polls.test/" },
    { MONGODB_URI: "mongodb://user:SENSITIVE@127.0.0.1:27017/" },
    { MONGODB_URI: "https://user:SENSITIVE@polls.test/database" },
    { BETTER_AUTH_SECRETS: "SENSITIVE-not-json" },
    { BETTER_AUTH_SECRETS: JSON.stringify([{ version: 1, value: " ".repeat(32) }]) },
    { BETTER_AUTH_SECRET: "generate-a-random-secret-with-at-least-32-characters" },
    { VOTER_SECRET: "too-short-SENSITIVE" },
  ]) {
    const errors = productionConfigErrors({ ...valid, ...patch });
    assert.ok(errors.length);
    assert.ok(!JSON.stringify(errors).includes("SENSITIVE"));
  }
});

test("Google-only deployments do not require Resend, and email-only deployments require a real sender", () => {
  assert.deepEqual(productionConfigErrors({ ...valid, AUTH_EMAIL_FROM: "Service <sign-in@your-verified-domain.com>" }), []);
  const email = { ...valid, GOOGLE_CLIENT_ID: "", GOOGLE_CLIENT_SECRET: "", RESEND_API_KEY: "fixture-key", AUTH_EMAIL_FROM: "Service <signin@polls.test>" };
  assert.deepEqual(productionConfigErrors(email), []);
  for (const sender of ["", "not-an-email", "support@example.com", "Service <signin@your-verified-domain.com>", "sender\nheader"]) {
    assert.ok(productionConfigErrors({ ...email, AUTH_EMAIL_FROM: sender }).some((error) => error.includes("AUTH_EMAIL_FROM")));
  }
});

test("production CORS origins never silently include a previous or development frontend", () => {
  const saved = { NODE_ENV: process.env.NODE_ENV, CLIENT_ORIGINS: process.env.CLIENT_ORIGINS };
  try {
    process.env.NODE_ENV = "production";
    process.env.CLIENT_ORIGINS = "https://polls.test,https://polls.test";
    assert.deepEqual(getClientOrigins(), ["https://polls.test"]);
    delete process.env.CLIENT_ORIGINS;
    assert.deepEqual(getClientOrigins(), []);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("Vercel build is wired to a fail-closed configuration and real-entrypoint check", () => {
  const config = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url)));
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url)));
  assert.equal(config.buildCommand, "npm run check:production");
  assert.equal(pkg.scripts["check:production"], "node scripts/check-production.js");
  const run = (patch) => spawnSync(process.execPath, ["scripts/check-production.js"], {
    cwd: new URL("..", import.meta.url), encoding: "utf8", timeout: 10_000,
    // No inherited provider credentials, .env files or production URI.
    env: { PATH: process.env.PATH, ...valid, ...patch },
  });
  const missing = run({ VOTER_SECRET: "" });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /VOTER_SECRET/);
  assert.ok(!missing.stderr.includes(valid.BETTER_AUTH_SECRET));
  const complete = run({});
  assert.equal(complete.status, 0, complete.stderr);
  assert.match(complete.stdout, /Express entrypoint passed/);
  assert.match(complete.stdout, /NOT verified/);
});
