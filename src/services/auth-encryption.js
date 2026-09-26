import { parseEnvelope, symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";

const encryptedFields = {
  account: ["accessToken", "refreshToken", "idToken"],
  twoFactor: ["secret", "backupCodes"],
};

// Only ciphertext belongs here. Plaintext OAuth imports use encrypt-oauth first.
// Never log document identifiers, secrets, tokens or decrypted values.
export async function rotateAuthEncryption(database, key, { apply = false, verify = false } = {}) {
  if (!key?.keys?.has(key.currentVersion)) throw new Error("A current versioned auth encryption key is required");

  async function scan(write) {
    const counts = { fields: 0, outdated: 0, changed: 0, conflicts: 0 };
    for (const [name, fields] of Object.entries(encryptedFields)) {
      const collection = database.collection(name);
      const projection = Object.fromEntries(fields.map((field) => [field, 1]));
      for await (const document of collection.find({}, { projection })) {
        const replacements = {};
        const expected = { _id: document._id };
        for (const field of fields) {
          const value = document[field];
          if (value === null || value === undefined || value === "") continue;
          counts.fields += 1;
          let plaintext;
          try {
            if (typeof value !== "string") throw new Error("Invalid ciphertext");
            plaintext = await symmetricDecrypt({ key, data: value });
          } catch {
            throw new Error(`Cannot decrypt ${name}.${field}; preserve old keys and repair/import the record before rotation`);
          }
          expected[field] = value;
          if (parseEnvelope(value)?.version === key.currentVersion) continue;
          counts.outdated += 1;
          if (write) replacements[field] = await symmetricEncrypt({ key, data: plaintext });
        }
        if (Object.keys(replacements).length) {
          // A refreshed token, consumed recovery code or replacement factor
          // must never be overwritten with the snapshot read by this scan.
          const result = await collection.updateOne(expected, { $set: replacements });
          if (result.matchedCount) counts.changed += Object.keys(replacements).length;
          else counts.conflicts += 1;
        }
      }
    }
    return counts;
  }

  const initial = await scan(false);
  if (verify) {
    if (initial.outdated) throw new Error(`${initial.outdated} encrypted fields still require an older key`);
    return initial;
  }
  if (!apply) return initial;
  // Preflight above decrypts every field before the first write. Partial
  // progress after a concurrent change is safe to rerun while old keys remain.
  const result = await scan(true);
  if (result.conflicts) throw new Error("Concurrent auth updates detected; keep old keys and rerun rotation");
  const remaining = await scan(false);
  if (remaining.outdated) throw new Error("Older-key writes detected; drain old deployments and rerun rotation");
  return { ...remaining, changed: result.changed };
}
