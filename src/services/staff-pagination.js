import { createHash } from "node:crypto";
import { ObjectId } from "mongodb";

export class StaffPaginationError extends Error {}

function decode(token, scope, allowStringId) {
  try {
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{1,1024}$/.test(token)) throw new Error();
    const value = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
    if (value.scope !== scope || typeof value.date !== "string" || !Number.isFinite(Date.parse(value.date))) throw new Error();
    if (typeof value.id !== "string" || !value.id.length || value.id.length > 200) throw new Error();
    if (value.type !== "string" && value.type !== "objectId") throw new Error();
    if (value.type === "string" && !allowStringId) throw new Error();
    if (value.type === "objectId" && !/^[a-f0-9]{24}$/.test(value.id)) throw new Error();
    return { date: new Date(value.date), id: value.type === "objectId" ? new ObjectId(value.id) : value.id, type: value.type };
  } catch { throw new StaffPaginationError("Invalid cursor for this list. Refresh and try again."); }
}

// Stable newest-first ordering with an immutable tie-breaker. Account IDs can
// be BSON ObjectIds or strings; Mongo's range operators are type-bracketed.
export async function paginateStaff(model, { query = {}, filter = {}, scope, limit = 25, select } = {}) {
  if (query.page !== undefined && query.page !== "1") throw new StaffPaginationError("Use nextCursor to load older records; numbered pages are no longer supported.");
  const size = query.limit === undefined ? limit : Number(query.limit);
  if (!Number.isSafeInteger(size) || size < 1 || size > 50) throw new StaffPaginationError("Limit must be between 1 and 50");
  const scopeKey = createHash("sha256").update(scope).digest("base64url");
  let condition = filter;
  if (query.cursor !== undefined) {
    const cursor = decode(query.cursor, scopeKey, model.schema.path("_id").instance === "Mixed");
    const branches = [
      { createdAt: { $lt: cursor.date } },
      { createdAt: cursor.date, _id: { $lt: cursor.id } },
    ];
    // Strings sort below ObjectIds at an equal timestamp. Include that BSON
    // type explicitly, without coercing a 24-character string into an ObjectId.
    if (cursor.type === "objectId") branches.push({ createdAt: cursor.date, _id: { $type: "string" } });
    condition = { $and: [filter, { createdAt: { $lte: cursor.date } }, { $or: branches }] };
  }
  let request = model.find(condition).sort({ createdAt: -1, _id: -1 }).limit(size + 1).maxTimeMS(5000);
  if (select) request = request.select(select);
  const rows = await request.lean();
  const items = rows.slice(0, size);
  const last = items.at(-1);
  const nextCursor = rows.length > size ? Buffer.from(JSON.stringify({
    scope: scopeKey, date: last.createdAt, id: String(last._id), type: typeof last._id === "string" ? "string" : "objectId",
  })).toString("base64url") : null;
  return { items, nextCursor };
}
