import mongoose from "mongoose";
import { createHash } from "node:crypto";
import Poll from "../models/Poll.js";

export class PaginationError extends Error {}

function decodeCursor(token, scope, fields) {
  try {
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{1,1024}$/.test(token)) throw new Error();
    const cursor = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
    if (cursor.scope !== scope || !Array.isArray(cursor.values) || cursor.values.length !== fields.length) throw new Error();
    return cursor.values.map((value, index) => {
      const field = fields[index];
      if (field === "_id") {
        if (typeof value !== "string" || !/^[a-f0-9]{24}$/.test(value)) throw new Error();
        return new mongoose.Types.ObjectId(value);
      }
      if (field === "totalVotes") {
        if (!Number.isSafeInteger(value) || value < 0) throw new Error();
        return value;
      }
      if (field === "lastVotedAt" && value === null) return null;
      if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error();
      return new Date(value);
    });
  } catch { throw new PaginationError("Invalid cursor for this poll list. Refresh the list and try again."); }
}

function afterCursor(fields, values) {
  const branches = [];
  const equal = {};
  fields.forEach((field, index) => {
    const value = values[index];
    if (value !== null) branches.push({ ...equal, [field]: { $lt: value } });
    // MongoDB range comparisons are type-bracketed: null dates need their
    // own branch when moving past a non-null date in descending order.
    if (field === "lastVotedAt" && value !== null) branches.push({ ...equal, [field]: null });
    equal[field] = value;
  });
  return { $or: branches };
}

export async function paginatePolls({ query, filter, scope, trending = false, defaultLimit = 50, maxLimit = 100 }) {
  const scopeKey = createHash("sha256").update(scope).digest("base64url");
  if (query.page !== undefined && query.page !== "1") throw new PaginationError("Use nextCursor to load more polls; numbered pages are no longer supported.");
  const limit = query.limit === undefined ? defaultLimit : Number(query.limit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maxLimit) throw new PaginationError(`Limit must be between 1 and ${maxLimit}`);
  const fields = trending ? ["totalVotes", "lastVotedAt", "createdAt", "_id"] : ["createdAt", "_id"];
  const sort = Object.fromEntries(fields.map((field) => [field, -1]));
  const values = query.cursor === undefined ? null : decodeCursor(query.cursor, scopeKey, fields);
  // The redundant leading-key bound lets MongoDB seek directly into the ordered
  // index instead of scanning previous pages before evaluating the tie-breaker.
  const condition = values ? { $and: [filter, { [fields[0]]: { $lte: values[0] } }, afterCursor(fields, values)] } : filter;
  const rows = await Poll.find(condition).sort(sort).maxTimeMS(5000).limit(limit + 1);
  const polls = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  const last = polls.at(-1);
  const nextCursor = hasMore ? Buffer.from(JSON.stringify({
    scope: scopeKey, values: fields.map((field) => last[field] ?? null),
  })).toString("base64url") : null;
  return { polls, hasMore, nextCursor };
}
