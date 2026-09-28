import { createHash, createHmac } from "node:crypto";
import CommandReceipt from "../models/CommandReceipt.js";
import { getVoterSecret } from "../voter.js";
import { IdentityError, withIdentityTransaction } from "./identity-transaction.js";

const DAY = 24 * 60 * 60 * 1000;

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

// Result mappings must store only identifiers/counts, never whole documents,
// request bodies, cookies, tokens or private response snapshots.
export async function withCommand(request, work, policy = {}, mapping = {}) {
  const key = request.get("Idempotency-Key");
  if (key !== undefined && !/^[A-Za-z0-9_-]{20,128}$/.test(key)) {
    throw new IdentityError("Idempotency-Key must contain 20–128 letters, numbers, hyphens or underscores", 400);
  }
  const actor = request.get("X-Command-Actor");
  if (actor !== undefined && actor !== request.auth.user.id) {
    throw new IdentityError("Your signed-in account changed. Reload before submitting again", 409, "ACCOUNT_CHANGED");
  }
  const operation = `${request.method} ${request.baseUrl}${request.route.path}`;
  const id = key && createHash("sha256").update(JSON.stringify([request.auth.user.id, operation, request.params, key])).digest("hex");
  const requestHash = key && createHmac("sha256", getVoterSecret()).update(JSON.stringify(canonical(request.body ?? null))).digest("hex");
  let replayed = false;
  const result = await withIdentityTransaction(request.auth, async (session, principal) => {
    replayed = false; // MongoDB may retry the entire transaction.
    if (!key) return work(session, principal);
    const saved = await CommandReceipt.findById(id).select("+requestHash").session(session).lean();
    if (saved && saved.expiresAt > new Date()) {
      if (saved.requestHash !== requestHash) throw new IdentityError("This command key was already used with different data", 409, "COMMAND_CONFLICT");
      replayed = true;
      return mapping.restore ? mapping.restore(saved.result, session) : saved.result;
    }
    if (saved) await CommandReceipt.deleteOne({ _id: id }, { session });
    const value = await work(session, principal);
    await CommandReceipt.create([{
      _id: id, actorId: request.auth.user.id, operation, requestHash,
      result: mapping.store ? mapping.store(value) : value ?? null,
      expiresAt: new Date(Date.now() + DAY),
    }], { session });
    return value;
  }, policy);
  request.commandReplayed = replayed;
  return result;
}
