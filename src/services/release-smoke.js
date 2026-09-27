export function releaseOrigin(value) {
  try {
    const url = new URL(value);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (value !== url.origin || (url.protocol !== "https:" && !(local && url.protocol === "http:"))) throw new Error();
    return url.origin;
  } catch { throw new Error("Supply an HTTPS origin without credentials, path, query or trailing slash (HTTP is allowed only on loopback)"); }
}

const health = (data) => data?.status === "ok" && typeof data.requestId === "string" && data.requestId.length > 0;
const providers = (data) => typeof data?.google === "boolean" && typeof data.magicLink === "boolean" && (data.google || data.magicLink);
const feed = (data) => Array.isArray(data?.polls) && data.polls.length <= 1 &&
  typeof data.hasMore === "boolean" && (data.nextCursor === null || typeof data.nextCursor === "string") &&
  data.hasMore === Boolean(data.nextCursor) && data.polls.every((poll) =>
    typeof poll.id === "string" && typeof poll.question === "string" && Array.isArray(poll.options) && !("creatorId" in poll));

export async function smokeRelease({ apiOrigin, siteOrigin, fetchImpl = fetch, timeoutMs = 10_000 }) {
  const api = releaseOrigin(apiOrigin);
  const site = releaseOrigin(siteOrigin);
  const checks = [
    ...[["backend", api], ["frontend proxy", site]].flatMap(([name, origin]) => [
      { name: `${name}: liveness`, url: `${origin}/api/health/live`, validate: health },
      { name: `${name}: database readiness`, url: `${origin}/api/health`, validate: health },
      { name: `${name}: sign-in configuration`, url: `${origin}/api/auth-config`, validate: providers },
      { name: `${name}: cursor feed`, url: `${origin}/api/polls?limit=1&stats=false`, validate: feed },
    ]),
    { name: "frontend: homepage and security headers", url: site, html: true, validate: (body, response) =>
      /<main[\s>]/i.test(body) && response.headers.get("content-type")?.includes("text/html") &&
      response.headers.get("x-frame-options")?.toUpperCase() === "DENY" &&
      response.headers.get("x-content-type-options") === "nosniff" &&
      /frame-ancestors\s+'none'/.test(response.headers.get("content-security-policy") || "") &&
      Boolean(response.headers.get("referrer-policy")) && Boolean(response.headers.get("permissions-policy")) },
  ];

  return Promise.all(checks.map(async (check) => {
    try {
      const response = await fetchImpl(check.url, {
        method: "GET", redirect: "error", cache: "no-store",
        signal: AbortSignal.timeout(timeoutMs),
        headers: { Accept: check.html ? "text/html" : "application/json" },
      });
      if (response.status !== 200) {
        await response.body?.cancel();
        return { name: check.name, ok: false, error: `HTTP ${response.status}` };
      }
      const body = check.html ? await response.text() : await response.json();
      return check.validate(body, response)
        ? { name: check.name, ok: true }
        : { name: check.name, ok: false, error: "Unexpected response or missing required headers" };
    } catch {
      // Never print response bodies, polls, provider errors or transport details.
      return { name: check.name, ok: false, error: "Request failed, redirected, timed out or returned invalid data" };
    }
  }));
}
