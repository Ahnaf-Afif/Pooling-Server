import { randomUUID } from "node:crypto";
import { Router } from "express";
import { ObjectId } from "mongodb";

import { requireVerifiedUser } from "../auth-middleware.js";
import { withDatabaseTransaction, getMongoDatabase } from "../db.js";
import AuthSession from "../models/AuthSession.js";
import AuthUser from "../models/AuthUser.js";
import ModerationAction from "../models/ModerationAction.js";
import Poll from "../models/Poll.js";
import Report from "../models/Report.js";
import VoteReceipt from "../models/VoteReceipt.js";
import { limitWrites } from "../rate-limit.js";
import { getAccountVoterKey } from "../voter.js";

const router = Router();

function idCandidates(value) {
  const candidates = [value];
  if (ObjectId.isValid(value)) candidates.push(new ObjectId(value));
  return candidates;
}

function accountFilter(userId) {
  return { _id: { $in: idCandidates(userId) } };
}

router.use(requireVerifiedUser);

router.get("/export", async (request, response, next) => {
  try {
    const userId = request.auth.user.id;
    const voterKey = getAccountVoterKey(userId);
    const [user, polls, votes, reports, moderationActions] = await Promise.all([
      AuthUser.findOne(accountFilter(userId)).select("name email emailVerified role createdAt").lean(),
      Poll.find({ creatorId: userId }).select("slug question category options totalVotes status createdAt updatedAt moderatedAt").sort({ createdAt: 1 }).lean(),
      VoteReceipt.find({ voterKey }).select("pollSlug optionId createdAt").sort({ createdAt: 1 }).lean(),
      Report.find({ reporterUserId: userId }).select("pollSlug reason details status createdAt reviewedAt").sort({ createdAt: 1 }).lean(),
      ModerationAction.find({ actorId: userId }).select("action pollSlug reportId targetUserId note changedFields createdAt").sort({ createdAt: 1 }).lean(),
    ]);
    response.set("Cache-Control", "no-store");
    return response.json({
      exportedAt: new Date().toISOString(),
      account: user ? {
        id: String(user._id),
        name: user.name || "",
        email: user.email,
        emailVerified: Boolean(user.emailVerified),
        role: user.role || "user",
        createdAt: user.createdAt,
      } : null,
      polls,
      votes,
      reports,
      moderationActions,
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/delete", limitWrites, async (request, response, next) => {
  try {
    if (request.body?.confirmation !== "DELETE") {
      return response.status(400).json({ message: "Type DELETE to confirm account removal" });
    }
    const userId = request.auth.user.id;
    await withDatabaseTransaction(async (session) => {
      const user = await AuthUser.findOne(accountFilter(userId)).session(session).lean();
      if (!user) return;
      if (String(user.role || "") === "admin") {
        const activeAdminCount = await AuthUser.countDocuments({ role: "admin", banned: { $ne: true } }).session(session);
        if (activeAdminCount <= 1) {
          const error = new Error("Create another active administrator before deleting this account");
          error.status = 409;
          throw error;
        }
      }

      const now = new Date();
      await Poll.updateMany(
        { creatorId: userId },
        { $set: { creatorId: null, status: "archived", deletedAt: now } },
        { session },
      );
      await Report.updateMany(
        { reporterUserId: userId },
        { $set: { reporterUserId: null } },
        { session },
      );
      const anonymizedActorId = `deleted:${randomUUID()}`;
      await ModerationAction.updateMany(
        { $or: [{ targetUserId: userId }, { actorId: userId }] },
        { $set: { targetUserId: null, actorId: anonymizedActorId, actorName: "Deleted user" } },
        { session },
      );

      // Keep anonymous integrity receipts, but remove the link to the deleted account.
      await VoteReceipt.updateMany(
        { voterKey: getAccountVoterKey(userId) },
        { $set: { voterKey: `deleted:${randomUUID()}` } },
        { session },
      );
      await AuthSession.deleteMany({ userId: { $in: idCandidates(userId) } }, { session });
      await getMongoDatabase().collection("account").deleteMany({ userId }, { session });
      await getMongoDatabase().collection("verification").deleteMany({ identifier: user.email }, { session });
      await AuthUser.deleteOne({ _id: user._id }, { session });
    });
    return response.status(204).end();
  } catch (error) {
    if (error.status === 409) return response.status(409).json({ message: error.message });
    return next(error);
  }
});

export default router;
