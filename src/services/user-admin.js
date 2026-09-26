import { ObjectId } from "mongodb";

import AuthSession from "../models/AuthSession.js";
import AuthUser from "../models/AuthUser.js";
import AdminGuard from "../models/AdminGuard.js";

const ADMIN_ROLE = /(^|,)admin(,|$)/;

export class UserAdminError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "UserAdminError";
    this.status = status;
  }
}

export function idCandidates(value) {
  const candidates = [value];
  if (ObjectId.isValid(value)) candidates.push(new ObjectId(value));
  return candidates;
}

function userIdFilter(value, field = "_id") {
  return { [field]: { $in: idCandidates(value) } };
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function serializeAuthUser(user) {
  if (!user) return null;
  return { ...user, id: String(user._id), _id: undefined };
}

export async function listAuthUsers({ page, limit, searchField, searchValue }) {
  const filter = searchValue
    ? { [searchField]: { $regex: escapeRegex(searchValue), $options: "i" } }
    : {};
  const [users, total] = await Promise.all([
    AuthUser.find(filter).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    AuthUser.countDocuments(filter),
  ]);
  return { users: users.map(serializeAuthUser), total };
}

export async function findAuthUserById(userId, { session } = {}) {
  const user = await AuthUser.findOne(userIdFilter(userId)).session(session || null).lean();
  return serializeAuthUser(user);
}

// A shared write prevents snapshot-isolation write skew when two different
// administrators are demoted, suspended or deleted concurrently.
export async function lockAdminChanges(session) {
  if (!session) throw new Error("Administrator changes require a transaction");
  await AdminGuard.updateOne(
    { _id: "administrators" },
    { $inc: { revision: 1 } },
    { upsert: true, session },
  );
}

export async function assertAdminWillRemain(user, { session } = {}) {
  if (!ADMIN_ROLE.test(String(user.role || "")) || user.banned) return;
  const activeAdmins = await AuthUser.countDocuments(
    { role: ADMIN_ROLE, banned: { $ne: true } },
  ).session(session || null);
  if (activeAdmins <= 1) {
    throw new UserAdminError("Create another active administrator before changing this account", 409);
  }
}

export async function setAuthUserRole(userId, role, { session } = {}) {
  await lockAdminChanges(session);
  const current = await AuthUser.findOne(userIdFilter(userId)).session(session || null).lean();
  if (!current) throw new UserAdminError("User not found", 404);
  if (role !== "admin") await assertAdminWillRemain(current, { session });

  const updated = await AuthUser.findOneAndUpdate(
    { _id: current._id },
    { $set: { role, updatedAt: new Date() } },
    { returnDocument: "after", session },
  ).lean();
  if (!updated) throw new UserAdminError("User not found", 404);

  await AuthSession.deleteMany(userIdFilter(userId, "userId"), { session });
  return serializeAuthUser(updated);
}

export async function suspendAuthUser(userId, reason, { session } = {}) {
  await lockAdminChanges(session);
  const current = await AuthUser.findOne(userIdFilter(userId)).session(session || null).lean();
  if (!current) throw new UserAdminError("User not found", 404);
  await assertAdminWillRemain(current, { session });

  const updated = await AuthUser.findOneAndUpdate(
    { _id: current._id },
    {
      $set: {
        banned: true,
        banReason: reason,
        banExpires: null,
        updatedAt: new Date(),
      },
    },
    { returnDocument: "after", session },
  ).lean();
  await AuthSession.deleteMany(userIdFilter(userId, "userId"), { session });
  return serializeAuthUser(updated);
}

export async function reactivateAuthUser(userId, { session } = {}) {
  const updated = await AuthUser.findOneAndUpdate(
    userIdFilter(userId),
    {
      $set: { banned: false, updatedAt: new Date() },
      $unset: { banReason: "", banExpires: "" },
    },
    { returnDocument: "after", session },
  ).lean();
  if (!updated) throw new UserAdminError("User not found", 404);
  return serializeAuthUser(updated);
}
