import { parseArgs } from "node:util";
import { smokeRelease } from "../src/services/release-smoke.js";

try {
  const { values } = parseArgs({ options: { api: { type: "string" }, site: { type: "string" } }, strict: true });
  const results = await smokeRelease({ apiOrigin: values.api, siteOrigin: values.site });
  for (const result of results) console.log(`${result.ok ? "PASS" : "FAIL"} ${result.name}${result.error ? `: ${result.error}` : ""}`);
  if (results.some((result) => !result.ok)) process.exitCode = 1;
  else console.log("Public release smoke checks passed. This does not verify sign-in callbacks, write permissions, indexes, backup recovery or voter-key history.");
} catch {
  console.error("Usage: npm run check:release -- --api https://api-host --site https://frontend-host (origins only; HTTP loopback allowed for local tests)");
  process.exitCode = 1;
}
