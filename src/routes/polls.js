import { Router } from "express";
import rateLimit from "express-rate-limit";
import mongoose from "mongoose";

import { CATEGORIES } from "../constants.js";
import Poll from "../models/Poll.js";
import { createSlug, validatePoll } from "../validation.js";

const router = Router();

const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { message: "Too many requests. Please try again in a minute." },
});

router.get("/", async (request, response, next) => {
  try {
    const filter = {};
    if (request.query.category && CATEGORIES.includes(request.query.category)) {
      filter.category = request.query.category;
    }
    if (request.query.trending === "true") filter.totalVotes = { $gte: 10 };

    const limit = Math.min(Math.max(Number(request.query.limit) || 50, 1), 100);
    const [polls, totals, categories, trending] = await Promise.all([
      Poll.find(filter).sort({ totalVotes: -1, createdAt: -1 }).limit(limit),
      Poll.aggregate([
        { $group: { _id: null, activePolls: { $sum: 1 }, totalVotes: { $sum: "$totalVotes" } } },
      ]),
      Poll.distinct("category"),
      Poll.countDocuments({ totalVotes: { $gte: 10 } }),
    ]);

    response.json({
      polls,
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

router.post("/", writeLimiter, async (request, response, next) => {
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

router.post("/:slug/votes", writeLimiter, async (request, response, next) => {
  try {
    const { optionId } = request.body;
    if (typeof optionId !== "string" || !mongoose.isValidObjectId(optionId)) {
      return response.status(400).json({ message: "Choose an option" });
    }

    const poll = await Poll.findOneAndUpdate(
      { slug: request.params.slug, "options._id": optionId },
      { $inc: { "options.$.votes": 1, totalVotes: 1 } },
      { new: true, runValidators: true },
    );
    if (!poll) return response.status(404).json({ message: "Poll or option not found" });
    return response.json({ poll });
  } catch (error) {
    return next(error);
  }
});

export default router;
