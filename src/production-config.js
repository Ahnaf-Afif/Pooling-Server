import { MongoClient } from "mongodb";
import { parseAuthSecrets } from "./auth-secrets.js";

function isHttpsOrigin(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && value === url.origin;
  } catch { return false; }
}

// Only return fixed descriptions, never values or parser errors containing secrets.
export function productionConfigErrors(env = process.env) {
  const read = (name) => env[name]?.trim() || "";
  const errors = [];
  for (const name of ["BETTER_AUTH_SECRET", "VOTER_SECRET"]) {
    const value = read(name);
    if (value.length < 32 || /^(development-only-secret|generate-a-random-secret)/.test(value)) {
      errors.push(`${name} must be configured with a non-placeholder secret of at least 32 characters`);
    }
  }
  try {
    const secrets = parseAuthSecrets(read("BETTER_AUTH_SECRETS"), read("BETTER_AUTH_SECRET"));
    if (secrets.some(({ value }) => value.trim().length < 32 || /^(development-only-secret|generate-a-random-secret)/.test(value))) throw new Error();
  }
  catch { errors.push("BETTER_AUTH_SECRETS must contain a valid JSON array of distinct versions and 32-character minimum keys"); }

  const uri = read("MONGODB_URI");
  try {
    // Parsing does not connect. Require an explicit database to avoid defaulting to test.
    if (!/^mongodb(?:\+srv)?:\/\/[^/]+\/[^/?#]+(?:\?[^#]*)?$/.test(uri)) throw new Error();
    new MongoClient(uri);
  } catch { errors.push("MONGODB_URI must be a valid MongoDB URI with an explicit database name"); }

  const origin = read("BETTER_AUTH_URL");
  if (!isHttpsOrigin(origin)) errors.push("BETTER_AUTH_URL must be an HTTPS frontend origin without a path or trailing slash");
  const origins = read("CLIENT_ORIGINS").split(",").map((value) => value.trim()).filter(Boolean);
  if (!origins.length || origins.some((value) => !isHttpsOrigin(value))) {
    errors.push("CLIENT_ORIGINS must explicitly list HTTPS origins without paths or trailing slashes");
  }
  if (!origins.includes(origin)) errors.push("CLIENT_ORIGINS must include BETTER_AUTH_URL");

  const googleId = read("GOOGLE_CLIENT_ID");
  const googleSecret = read("GOOGLE_CLIENT_SECRET");
  if (Boolean(googleId) !== Boolean(googleSecret)) errors.push("Configure both GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, or neither");
  const emailKey = read("RESEND_API_KEY");
  const emailFrom = read("AUTH_EMAIL_FROM");
  const sender = emailFrom.match(/^[^<>\r\n]*<([^<>\s]+)>$/)?.[1] || emailFrom;
  if (emailKey && (!/^[^<>\s@]+@[^<>\s@]+\.[^<>\s@]+$/.test(sender) || /[\r\n]|example\.com|your-verified-domain\.com/i.test(emailFrom))) {
    errors.push("AUTH_EMAIL_FROM must be a real sender on your verified domain when RESEND_API_KEY is configured");
  }
  if (!(googleId && googleSecret) && !emailKey) errors.push("Configure at least one sign-in provider (Google or Resend)");
  return errors;
}

export function assertProductionConfig(env = process.env) {
  const errors = productionConfigErrors(env);
  if (errors.length) throw new Error(`Production configuration is incomplete:\n${errors.join("\n")}`);
}
