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
import { paginatePolls, PaginationError } from "../services/poll-pagination.js";
import { getPlatformStats } from "../services/platform-stats.js";
import { recordVote, VoteError } from "../services/voting.js";

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

    const trending = request.query.trending === "true";
    const scope = JSON.stringify(["public", filter.category || "", trending, filter.slug?.$in?.slice().sort() || []]);
    const result = await paginatePolls({ query: request.query, filter, scope, trending });
    const includeStats = request.query.cursor === undefined && request.query.stats !== "false";
    const stats = includeStats ? await getPlatformStats(request.id) : undefined;

    response.set("Cache-Control", "public, max-age=10, stale-while-revalidate=30");
    return response.json({ ...result, ...(includeStats ? { stats } : {}) });
  } catch (error) {
    if (error instanceof PaginationError) return response.status(400).json({ message: error.message });
    return next(error);
  }
});

router.get("/mine", requireVerifiedUser, async (request, response, next) => {
  response.set("Cache-Control", "private, no-store");
  try {
    const result = await paginatePolls({
      query: request.query, filter: { creatorId: request.auth.user.id, ...notDeleted },
      scope: `mine:${request.auth.user.id}`, defaultLimit: 24, maxLimit: 50,
    });
    return response.json(result);
  } catch (error) {
    if (error instanceof PaginationError) return response.status(400).json({ message: error.message });
    return next(error);
  }
});

router.get("/mine/:slug", requireVerifiedUser, async (request, response, next) => {
  response.set("Cache-Control", "private, no-store");
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
    response.set("Cache-Control", "public, max-age=5, stale-while-revalidate=15");
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

router.get("/:slug/my-vote", async (request, response, next) => {
  response.set("Cache-Control", "private, no-store");
  response.vary("Cookie");
  try {
    if (!await Poll.exists({ slug: request.params.slug, ...notDeleted })) return response.status(404).json({ message: "Poll not found" });
    const session = await readOptionalSession(request);
    // Establish the guest's signed cookie before their first submission so a
    // lost vote response can be retried with the same server-recognized identity.
    const voterKey = getVoterKey(request, response, session);
    const vote = await VoteReceipt.findOne({ pollSlug: request.params.slug, voterKey }).select("optionId -_id").lean();
    return response.json({ optionId: vote ? String(vote.optionId) : null });
  } catch (error) { return next(error); }
});

router.post("/:slug/votes", limitWrites, async (request, response, next) => {
  response.set("Cache-Control", "private, no-store");
  try {
    const optionId = request.body?.optionId;
    if (typeof optionId !== "string" || !mongoose.isValidObjectId(optionId)) {
      return response.status(400).json({ message: "Choose an option" });
    }

    const session = await readOptionalSession(request);
    const voterKey = getVoterKey(request, response, session);
    return response.json(await recordVote({ pollSlug: request.params.slug, voterKey, optionId: optionId.toLowerCase() }));
  } catch (error) {
    if (error instanceof VoteError) {
      return response.status(error.status).json({ message: error.message });
    }
    return next(error);
  }
});

export default router;
