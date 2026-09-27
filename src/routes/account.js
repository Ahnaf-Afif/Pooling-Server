import { randomUUID } from "node:crypto";
import { Router } from "express";

import { requireRecentAuth, requireVerifiedUser } from "../auth-middleware.js";
import { withDatabaseTransaction, getMongoDatabase } from "../db.js";
import AuthSession from "../models/AuthSession.js";
import AuthUser from "../models/AuthUser.js";
import ModerationAction from "../models/ModerationAction.js";
import Poll from "../models/Poll.js";
import Report from "../models/Report.js";
import RecoveryRequest from "../models/RecoveryRequest.js";
import VoteReceipt from "../models/VoteReceipt.js";
import { limitAccountReads, limitExports, limitWrites } from "../rate-limit.js";
import { getAccountVoterKey } from "../voter.js";
import { assertAdminWillRemain, idCandidates, lockAdminChanges, UserAdminError } from "../services/user-admin.js";
import { lockIdentity } from "../services/identity-transaction.js";

const router = Router();

function accountFilter(userId) {
  return { _id: { $in: idCandidates(userId) } };
}

router.use((_request, response, next) => {
  response.set("Cache-Control", "private, no-store");
  next();
});
router.use(requireVerifiedUser);
router.use(limitAccountReads);

router.get("/export", requireRecentAuth, limitExports, async (request, response, next) => {
  try {
    const userId = request.auth.user.id;
    const voterKey = getAccountVoterKey(userId);
    const [user, polls, votes, reports, moderationActions, recoveryRequest] = await Promise.all([
      AuthUser.findOne(accountFilter(userId)).select("name email emailVerified role createdAt").lean(),
      Poll.find({ creatorId: userId }).select("slug question category options totalVotes status createdAt updatedAt moderatedAt").sort({ createdAt: 1 }).lean(),
      VoteReceipt.find({ voterKey }).select("pollSlug optionId createdAt").sort({ createdAt: 1 }).lean(),
      Report.find({ reporterUserId: userId }).select("pollSlug reason details status createdAt reviewedAt").sort({ createdAt: 1 }).lean(),
      ModerationAction.find({ actorId: userId }).select("action pollSlug reportId targetUserId note changedFields createdAt").sort({ createdAt: 1 }).lean(),
      RecoveryRequest.findById(userId).select("requestId status createdAt expiresAt approvedAt -_id").lean(),
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
      recoveryRequest,
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/delete", requireRecentAuth, limitWrites, async (request, response, next) => {
  try {
    if (request.body?.confirmation !== "DELETE") {
      return response.status(400).json({ message: "Type DELETE to confirm account removal" });
    }
    const userId = request.auth.user.id;
    await withDatabaseTransaction(async (session) => {
      await lockAdminChanges(session);
      const { user } = await lockIdentity(request.auth, session, { recent: true });
      await assertAdminWillRemain(user, { session });

      const now = new Date();
      await Poll.updateMany(
        { creatorId: userId },
        { $set: { creatorId: null, status: "archived", deletedAt: now } },
        { session },
      );
      await Report.updateMany(
        { reporterUserId: userId },
        { $set: { reporterUserId: null, reporterKey: `deleted:${randomUUID()}` } },
        { session },
      );
      await Report.updateMany({ reviewedBy: userId }, { $set: { reviewedBy: null } }, { session });
      const anonymizedActorId = `deleted:${randomUUID()}`;
      await ModerationAction.updateMany(
        { targetUserId: userId },
        { $set: { targetUserId: null } },
        { session },
      );
      await ModerationAction.updateMany(
        { actorId: userId },
        { $set: { actorId: anonymizedActorId, actorName: "Deleted user" } },
        { session },
      );

      // Keep anonymous integrity receipts, but remove the link to the deleted account.
      await VoteReceipt.updateMany(
        { voterKey: getAccountVoterKey(userId) },
        { $set: { voterKey: `deleted:${randomUUID()}` } },
        { session },
      );
      await AuthSession.deleteMany({ userId: { $in: idCandidates(userId) } }, { session });
      await RecoveryRequest.deleteOne({ _id: userId }, { session });
      await RecoveryRequest.updateMany({ approvedBy: userId }, { $set: { approvedBy: null } }, { session });
      const database = getMongoDatabase();
      const userFilter = { userId: { $in: idCandidates(userId) } };
      await database.collection("account").deleteMany(userFilter, { session });
      await database.collection("twoFactor").deleteMany(userFilter, { session });
      await getMongoDatabase().collection("verification").deleteMany({ identifier: user.email }, { session });
      await AuthUser.deleteOne({ _id: user._id }, { session });
    });
    return response.status(204).end();
  } catch (error) {
    if (error instanceof UserAdminError) return response.status(error.status).json({ message: error.message });
    return next(error);
  }
});

export default router;
