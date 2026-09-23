import { Router } from "express";
import mongoose from "mongoose";

import { readOptionalSession, requireVerifiedUser } from "../auth-middleware.js";
import { CATEGORIES, TRENDING_MIN_VOTES, TRENDING_WINDOW_MS } from "../constants.js";
import Poll from "../models/Poll.js";
import Report from "../models/Report.js";
import VoteReceipt from "../models/VoteReceipt.js";
import { limitPollCreation, limitReports, limitWrites } from "../rate-limit.js";
import { createSlug, validatePoll } from "../validation.js";
import { getVoterKey } from "../voter.js";

const router = Router();
const notDeleted = { deletedAt: null };
const activeStatus = { $in: ["active", null] };

function ownerFilter(request) {
  return {
    slug: request.params.slug,
    creatorId: request.auth.user.id,
    ...notDeleted,
  };
}

router.get("/", async (request, response, next) => {
  try {
    const filter = { ...notDeleted, status: { $ne: "archived" } };
    if (request.query.category && CATEGORIES.includes(request.query.category)) {
      filter.category = request.query.category;
    }
    const trendCutoff = new Date(Date.now() - TRENDING_WINDOW_MS);
    const trendingFilter = {
      ...notDeleted,
      status: { $ne: "archived" },
      totalVotes: { $gte: TRENDING_MIN_VOTES },
      $or: [
        { lastVotedAt: { $gte: trendCutoff } },
        { lastVotedAt: null, createdAt: { $gte: trendCutoff } },
      ],
    };
    if (request.query.trending === "true") Object.assign(filter, trendingFilter);
    if (request.query.ids !== undefined) {
      const ids = [...new Set(String(request.query.ids).split(",").map((id) => id.trim()).filter(Boolean))];
      if (!ids.length || ids.length > 50 || ids.some((id) => !/^[a-z0-9-]{1,80}$/.test(id))) {
        return response.status(400).json({ message: "Poll IDs are invalid" });
      }
      filter.slug = { $in: ids };
    }

    const requestedLimit = request.query.limit === undefined ? 50 : Number(request.query.limit);
    const limit = Number.isSafeInteger(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 100) : 50;
    const page = request.query.page === undefined ? 1 : Number(request.query.page);
    if (!Number.isSafeInteger(page) || page < 1 || page > 10000) {
      return response.status(400).json({ message: "Page must be between 1 and 10000" });
    }
    const sort = request.query.trending === "true"
      ? { totalVotes: -1, lastVotedAt: -1, createdAt: -1 }
      : { createdAt: -1, _id: -1 };
    const [polls, totals, categories, trending] = await Promise.all([
      Poll.find(filter).sort(sort).skip((page - 1) * limit).limit(limit + 1),
      Poll.aggregate([
        { $match: { ...notDeleted, status: { $ne: "archived" } } },
        { $group: { _id: null, activePolls: { $sum: 1 }, totalVotes: { $sum: "$totalVotes" } } },
      ]),
      Poll.distinct("category", { ...notDeleted, status: { $ne: "archived" } }),
      Poll.countDocuments(trendingFilter),
    ]);

    return response.json({
      polls: polls.slice(0, limit),
      hasMore: polls.length > limit,
      stats: {
        activePolls: totals[0]?.activePolls || 0,
        totalVotes: totals[0]?.totalVotes || 0,
        categories: categories.length,
        trending,
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/mine", requireVerifiedUser, async (request, response, next) => {
  try {
    const polls = await Poll.find({ creatorId: request.auth.user.id, ...notDeleted })
      .sort({ createdAt: -1 })
      .limit(100);
    return response.json({ polls });
  } catch (error) {
    return next(error);
  }
});

router.get("/mine/:slug", requireVerifiedUser, async (request, response, next) => {
  try {
    const poll = await Poll.findOne(ownerFilter(request));
    if (!poll) return response.status(404).json({ message: "Poll not found" });
    return response.json({ poll });
  } catch (error) {
    return next(error);
  }
});

router.get("/:slug", async (request, response, next) => {
  try {
    const poll = await Poll.findOne({ slug: request.params.slug, ...notDeleted });
    if (!poll) return response.status(404).json({ message: "Poll not found" });
    return response.json({ poll });
  } catch (error) {
    return next(error);
  }
});

router.post("/", requireVerifiedUser, limitPollCreation, async (request, response, next) => {
  try {
    const { errors, value } = validatePoll(request.body);
    if (errors.length) return response.status(400).json({ message: errors[0], errors });

    const poll = await Poll.create({
      slug: createSlug(value.question),
      question: value.question,
      category: value.category,
      options: value.options.map((label) => ({ label })),
      creatorId: request.auth.user.id,
    });
    return response.status(201).json({ poll });
  } catch (error) {
    return next(error);
  }
});

router.patch("/:slug", requireVerifiedUser, limitWrites, async (request, response, next) => {
  try {
    const { errors, value } = validatePoll(request.body);
    if (errors.length) return response.status(400).json({ message: errors[0], errors });

    const poll = await Poll.findOneAndUpdate(
      { ...ownerFilter(request), totalVotes: 0, status: activeStatus },
      {
        $set: {
          question: value.question,
          category: value.category,
          options: value.options.map((label) => ({ label, votes: 0 })),
        },
      },
      { returnDocument: "after", runValidators: true },
    );
    if (poll) return response.json({ poll });

    const existing = await Poll.findOne(ownerFilter(request));
    if (!existing) return response.status(404).json({ message: "Poll not found" });
    return response.status(409).json({
      message: existing.totalVotes > 0
        ? "A poll cannot be edited after voting has started"
        : "Only an active poll can be edited",
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/:slug/close", requireVerifiedUser, limitWrites, async (request, response, next) => {
  try {
    const poll = await Poll.findOneAndUpdate(
      { ...ownerFilter(request), status: activeStatus },
      { $set: { status: "closed", closedAt: new Date() } },
      { returnDocument: "after", runValidators: true },
    );
    if (!poll) return response.status(404).json({ message: "Active poll not found" });
    return response.json({ poll });
  } catch (error) {
    return next(error);
  }
});

router.post("/:slug/archive", requireVerifiedUser, limitWrites, async (request, response, next) => {
  try {
    const poll = await Poll.findOneAndUpdate(
      ownerFilter(request),
      { $set: { status: "archived" } },
      { returnDocument: "after", runValidators: true },
    );
    if (!poll) return response.status(404).json({ message: "Poll not found" });
    return response.json({ poll });
  } catch (error) {
    return next(error);
  }
});

router.delete("/:slug", requireVerifiedUser, limitWrites, async (request, response, next) => {
  try {
    const poll = await Poll.findOneAndUpdate(
      ownerFilter(request),
      { $set: { status: "archived", deletedAt: new Date() } },
      { returnDocument: "after" },
    );
    if (!poll) return response.status(404).json({ message: "Poll not found" });
    return response.status(204).end();
  } catch (error) {
    return next(error);
  }
});

router.post("/:slug/reports", limitReports, async (request, response, next) => {
  try {
    const reason = typeof request.body?.reason === "string" ? request.body.reason.trim() : "";
    const details = typeof request.body?.details === "string" ? request.body.details.trim() : "";
    if (!["spam", "harassment", "hate", "misinformation", "other"].includes(reason)) {
      return response.status(400).json({ message: "Choose a report reason" });
    }
    if (details.length > 500) {
      return response.status(400).json({ message: "Report details cannot exceed 500 characters" });
    }
    const poll = await Poll.exists({ slug: request.params.slug, ...notDeleted });
    if (!poll) return response.status(404).json({ message: "Poll not found" });

    const session = await readOptionalSession(request);
    const reporterKey = getVoterKey(request, response, session);
    await Report.create({
      pollSlug: request.params.slug,
      reporterKey,
      reporterUserId: session?.user?.id || null,
      reason,
      details,
    });
    return response.status(201).json({ message: "Report submitted for review" });
  } catch (error) {
    if (error?.code === 11000) {
      return response.status(409).json({ message: "You have already reported this poll" });
    }
    return next(error);
  }
});

router.post("/:slug/votes", limitWrites, async (request, response, next) => {
  let receipt;
  try {
    const optionId = request.body?.optionId;
    if (typeof optionId !== "string" || !mongoose.isValidObjectId(optionId)) {
      return response.status(400).json({ message: "Choose an option" });
    }

    const session = await readOptionalSession(request);
    const voterKey = getVoterKey(request, response, session);
    receipt = await VoteReceipt.create({
      pollSlug: request.params.slug,
      voterKey,
      optionId,
    });

    const poll = await Poll.findOneAndUpdate(
      {
        slug: request.params.slug,
        "options._id": optionId,
        ...notDeleted,
        status: activeStatus,
      },
      { $inc: { "options.$.votes": 1, totalVotes: 1 }, $set: { lastVotedAt: new Date() } },
      { returnDocument: "after", runValidators: true },
    );
    if (!poll) {
      await VoteReceipt.deleteOne({ _id: receipt._id });
      const existing = await Poll.exists({ slug: request.params.slug, ...notDeleted });
      return response.status(existing ? 409 : 404).json({
        message: existing ? "This poll is closed or the option no longer exists" : "Poll not found",
      });
    }
    return response.json({ poll });
  } catch (error) {
    if (error?.code === 11000) {
      return response.status(409).json({ message: "You have already voted in this poll" });
    }
    if (receipt?._id) await VoteReceipt.deleteOne({ _id: receipt._id }).catch(() => {});
    return next(error);
  }
});

export default router;
