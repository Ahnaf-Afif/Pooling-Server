import { Router } from "express";
import { fromNodeHeaders } from "better-auth/node";
import mongoose from "mongoose";

import { auth } from "../auth.js";
import { requireAdmin, requireModerator } from "../auth-middleware.js";
import Poll from "../models/Poll.js";
import Report from "../models/Report.js";
import { limitWrites } from "../rate-limit.js";

const router = Router();
const VALID_STATUSES = ["pending", "resolved", "dismissed"];

router.use(requireModerator);

router.get("/reports", async (request, response, next) => {
  try {
    const status = VALID_STATUSES.includes(request.query.status) ? request.query.status : "pending";
    const reports = await Report.find({ status }).sort({ createdAt: -1 }).limit(100).lean();
    const pollSlugs = [...new Set(reports.map((report) => report.pollSlug))];
    const polls = await Poll.find({ slug: { $in: pollSlugs } }).lean();
    const pollsBySlug = new Map(polls.map((poll) => [poll.slug, poll]));

    return response.json({
      role: request.auth.effectiveRole,
      reports: reports.map((report) => {
        const poll = pollsBySlug.get(report.pollSlug);
        return {
          id: String(report._id),
          pollSlug: report.pollSlug,
          reason: report.reason,
          details: report.details,
          status: report.status,
          createdAt: report.createdAt,
          poll: poll
            ? {
                question: poll.question,
                status: poll.status || "active",
                creatorId: poll.creatorId || null,
                deleted: Boolean(poll.deletedAt),
              }
            : null,
        };
      }),
    });
  } catch (error) {
    return next(error);
  }
});

router.patch("/reports/:id", limitWrites, async (request, response, next) => {
  try {
    if (!mongoose.isValidObjectId(request.params.id) || !VALID_STATUSES.includes(request.body?.status)) {
      return response.status(400).json({ message: "Choose a valid report status" });
    }
    const report = await Report.findByIdAndUpdate(
      request.params.id,
      {
        $set: {
          status: request.body.status,
          reviewedBy: request.auth.user.id,
          reviewedAt: new Date(),
        },
      },
      { returnDocument: "after", runValidators: true },
    );
    if (!report) return response.status(404).json({ message: "Report not found" });
    return response.json({ report });
  } catch (error) {
    return next(error);
  }
});

router.post("/reports/:id/remove-poll", limitWrites, async (request, response, next) => {
  try {
    if (!mongoose.isValidObjectId(request.params.id)) {
      return response.status(400).json({ message: "Invalid report" });
    }
    const report = await Report.findById(request.params.id);
    if (!report) return response.status(404).json({ message: "Report not found" });

    await Promise.all([
      Poll.findOneAndUpdate(
        { slug: report.pollSlug, deletedAt: null },
        { $set: { status: "archived", deletedAt: new Date() } },
      ),
      Report.findByIdAndUpdate(report._id, {
        $set: { status: "resolved", reviewedBy: request.auth.user.id, reviewedAt: new Date() },
      }),
    ]);
    return response.json({ message: "Poll removed and report resolved" });
  } catch (error) {
    return next(error);
  }
});

router.post("/reports/:id/suspend-owner", requireAdmin, limitWrites, async (request, response, next) => {
  try {
    if (!mongoose.isValidObjectId(request.params.id)) {
      return response.status(400).json({ message: "Invalid report" });
    }
    const report = await Report.findById(request.params.id);
    if (!report) return response.status(404).json({ message: "Report not found" });
    const poll = await Poll.findOne({ slug: report.pollSlug });
    if (!poll?.creatorId) {
      return response.status(409).json({ message: "This legacy poll has no account owner" });
    }

    await auth.api.banUser({
      body: {
        userId: poll.creatorId,
        banReason: `Poll moderation: ${report.reason}`,
      },
      headers: fromNodeHeaders(request.headers),
    });
    return response.json({ message: "Poll owner suspended" });
  } catch (error) {
    return next(error);
  }
});

export default router;
