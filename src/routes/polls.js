import { Router } from "express";
import mongoose from "mongoose";

import { CATEGORIES, TRENDING_MIN_VOTES, TRENDING_WINDOW_MS } from "../constants.js";
import Poll from "../models/Poll.js";
import { limitWrites } from "../rate-limit.js";
import { createSlug, validatePoll } from "../validation.js";

const router = Router();

router.get("/", async (request, response, next) => {
  try {
    const filter = {};
    if (request.query.category && CATEGORIES.includes(request.query.category)) {
      filter.category = request.query.category;
    }
    const trendCutoff = new Date(Date.now() - TRENDING_WINDOW_MS);
    const trendingFilter = {
      totalVotes: { $gte: TRENDING_MIN_VOTES },
      $or: [
        { lastVotedAt: { $gte: trendCutoff } },
        { lastVotedAt: null, createdAt: { $gte: trendCutoff } },
      ],
    };
    if (request.query.trending === "true") {
      Object.assign(filter, trendingFilter);
    }
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
        { $group: { _id: null, activePolls: { $sum: 1 }, totalVotes: { $sum: "$totalVotes" } } },
      ]),
      Poll.distinct("category"),
      Poll.countDocuments(trendingFilter),
    ]);

    response.json({
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
    next(error);
  }
});

router.get("/:slug", async (request, response, next) => {
  try {
    const poll = await Poll.findOne({ slug: request.params.slug });
    if (!poll) return response.status(404).json({ message: "Poll not found" });
    return response.json({ poll });
  } catch (error) {
    return next(error);
  }
});

router.post("/", limitWrites, async (request, response, next) => {
  try {
    const { errors, value } = validatePoll(request.body);
    if (errors.length) return response.status(400).json({ message: errors[0], errors });

    const poll = await Poll.create({
      slug: createSlug(value.question),
      question: value.question,
      category: value.category,
      options: value.options.map((label) => ({ label })),
    });
    return response.status(201).json({ poll });
  } catch (error) {
    return next(error);
  }
});

router.post("/:slug/votes", limitWrites, async (request, response, next) => {
  try {
    const optionId = request.body?.optionId;
    if (typeof optionId !== "string" || !mongoose.isValidObjectId(optionId)) {
      return response.status(400).json({ message: "Choose an option" });
    }

    const poll = await Poll.findOneAndUpdate(
      { slug: request.params.slug, "options._id": optionId },
      { $inc: { "options.$.votes": 1, totalVotes: 1 }, $set: { lastVotedAt: new Date() } },
      { returnDocument: "after", runValidators: true },
    );
    if (!poll) return response.status(404).json({ message: "Poll or option not found" });
    return response.json({ poll });
  } catch (error) {
    return next(error);
  }
});

export default router;
