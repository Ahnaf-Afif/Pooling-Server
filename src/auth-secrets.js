export function parseAuthSecrets(configured, legacySecret) {
  if (!configured?.trim()) return [{ version: 1, value: legacySecret }];
  let secrets;
  try { secrets = JSON.parse(configured); }
  catch { throw new Error("BETTER_AUTH_SECRETS must be a JSON array of versioned secrets"); }

  if (!Array.isArray(secrets) || !secrets.length || secrets.some((entry) =>
    !entry || !Number.isSafeInteger(entry.version) || entry.version < 1 ||
    typeof entry.value !== "string" || entry.value.length < 32)) {
    throw new Error("BETTER_AUTH_SECRETS contains an invalid version or secret");
  }
  if (new Set(secrets.map((entry) => entry.version)).size !== secrets.length) {
    throw new Error("BETTER_AUTH_SECRETS must use distinct key versions");
  }
  return secrets;
}
