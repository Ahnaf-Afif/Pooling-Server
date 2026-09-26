import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import app from "../src/app.js";
import { getClientOrigins } from "../src/config.js";
import { closeDatabases } from "../src/db.js";
import { startServer, stopServer } from "./helpers/http.js";

let server;
let baseUrl;

before(async () => {
  server = await startServer(app);
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await stopServer(server);
  await closeDatabases();
});

test("Vercel entrypoint exports an Express app", () => {
  assert.equal(typeof app, "function");
});

test("root responds without a database connection", async () => {
  const response = await fetch(baseUrl);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).health, "/api/health");
});

test("liveness responds without a database connection and carries a request id", async () => {
  const response = await fetch(`${baseUrl}/api/health/live`, { headers: { "x-request-id": "health-check-1" } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-request-id"), "health-check-1");
  assert.deepEqual(await response.json(), { status: "ok", requestId: "health-check-1" });
});

test("production frontend origin is allowed by default", async () => {
  const response = await fetch(baseUrl, {
    headers: { Origin: "https://pooling-client.vercel.app" },
  });
  assert.equal(response.headers.get("access-control-allow-origin"), "https://pooling-client.vercel.app");
});

test("production frontend remains allowed with a local-only CORS setting", () => {
  const previous = process.env.CLIENT_ORIGINS;
  process.env.CLIENT_ORIGINS = "http://localhost:3000";
  try {
    assert.ok(getClientOrigins().includes("https://pooling-client.vercel.app"));
  } finally {
    if (previous === undefined) delete process.env.CLIENT_ORIGINS;
    else process.env.CLIENT_ORIGINS = previous;
  }
});
