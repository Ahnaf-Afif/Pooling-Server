import assert from "node:assert/strict";
import test from "node:test";
import { startServer, stopServer } from "./helpers/http.js";
import { releaseOrigin, smokeRelease } from "../src/services/release-smoke.js";

const origins = { apiOrigin: "https://api.test", siteOrigin: "https://site.test" };
const htmlHeaders = {
  "content-type": "text/html", "x-frame-options": "DENY", "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'self'; frame-ancestors 'none'",
  "referrer-policy": "strict-origin-when-cross-origin", "permissions-policy": "camera=()",
};

function healthy(url) {
  const { pathname } = new URL(url);
  if (pathname === "/") return new Response("<html><main>Polls</main></html>", { headers: htmlHeaders });
  if (pathname.includes("health")) return Response.json({ status: "ok", requestId: "test-request" });
  if (pathname === "/api/auth-config") return Response.json({ google: true, magicLink: false });
  return Response.json({ polls: [], hasMore: false, nextCursor: null });
}

test("release smoke validates both direct and proxied APIs without cookies or writes", async () => {
  const requests = [];
  const results = await smokeRelease({ ...origins, fetchImpl: async (url, options) => {
    requests.push(url);
    assert.equal(options.method, "GET");
    assert.equal(options.redirect, "error");
    assert.deepEqual(Object.keys(options.headers), ["Accept"]);
    assert.ok(options.signal instanceof AbortSignal);
    return healthy(url);
  } });
  assert.equal(results.length, 9);
  assert.ok(results.every((result) => result.ok));
  for (const origin of Object.values(origins)) assert.ok(requests.includes(`${origin}/api/polls?limit=1&stats=false`));
});

test("a healthy homepage cannot hide a broken backend, proxy or incompatible feed", async () => {
  for (const badResponse of [
    () => new Response("SENSITIVE FUNCTION_INVOCATION_FAILED", { status: 500 }),
    () => new Response("<html>Sign in to Vercel</html>"),
    () => Response.json({ polls: [], page: 1 }),
    () => { throw new Error("SENSITIVE transport error"); },
  ]) {
    const results = await smokeRelease({ ...origins, fetchImpl: async (url) =>
      url.startsWith(`${origins.siteOrigin}/api/polls`) ? badResponse() : healthy(url) });
    const failed = results.filter((result) => !result.ok);
    assert.equal(failed.length, 1);
    assert.equal(failed[0].name, "frontend proxy: cursor feed");
    assert.ok(!JSON.stringify(results).includes("SENSITIVE"));
  }
});

test("release smoke rejects disabled providers and missing frontend security headers", async () => {
  const results = await smokeRelease({ ...origins, fetchImpl: async (url) => {
    if (url.endsWith("auth-config")) return Response.json({ google: false, magicLink: false });
    if (url === origins.siteOrigin) return new Response("<main>Site</main>", { headers: { "content-type": "text/html" } });
    return healthy(url);
  } });
  assert.equal(results.filter((result) => !result.ok).length, 3);
});

test("release targets reject embedded credentials and redirects while allowing local integration servers", () => {
  for (const value of [undefined, "", "http://public.test", "https://user:secret@site.test", "https://site.test/", "https://site.test/path", "https://site.test?token=secret"]) {
    assert.throws(() => releaseOrigin(value));
  }
  assert.equal(releaseOrigin("http://127.0.0.1:5199"), "http://127.0.0.1:5199");
  assert.equal(releaseOrigin("https://site.test"), "https://site.test");
});

test("real HTTP smoke checks reject redirects and abort stalled responses", async () => {
  let mode = "healthy";
  let followedRedirect = false;
  const server = await startServer(async (request, response) => {
    assert.equal(request.method, "GET");
    if (request.url === "/unexpected") followedRedirect = true;
    if (mode === "stall" && request.url === "/api/health") return;
    if (mode === "redirect" && request.url === "/api/health") {
      response.writeHead(302, { Location: "/unexpected" });
      response.end();
      return;
    }
    const result = healthy(`http://127.0.0.1${request.url}`);
    response.writeHead(result.status, Object.fromEntries(result.headers));
    response.end(await result.text());
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const check = (timeoutMs = 1000) => smokeRelease({ apiOrigin: origin, siteOrigin: origin, timeoutMs });
    assert.ok((await check()).every((result) => result.ok));
    mode = "redirect";
    assert.equal((await check()).filter((result) => !result.ok).length, 2);
    assert.equal(followedRedirect, false);
    mode = "stall";
    const results = await check(2000);
    assert.equal(results.filter((result) => !result.ok).length, 2);
  } finally { await stopServer(server); }
});
