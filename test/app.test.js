import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import app from "../src/app.js";
import { getClientOrigins } from "../src/config.js";

let server;
let baseUrl;

before(async () => {
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test("Vercel entrypoint exports an Express app", () => {
  assert.equal(typeof app, "function");
});

test("root responds without a database connection", async () => {
  const response = await fetch(baseUrl);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).health, "/api/health");
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
