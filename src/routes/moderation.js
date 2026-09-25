import { Router } from "express";
import { fromNodeHeaders } from "better-auth/node";
import mongoose from "mongoose";

import { auth } from "../auth.js";
import { requireAdmin, requireModerator } from "../auth-middleware.js";
import ModerationAction from "../models/ModerationAction.js";
import Poll from "../models/Poll.js";
import Report from "../models/Report.js";
import { limitWrites } from "../rate-limit.js";
import { validatePoll } from "../validation.js";

const router = Router();
const REPORT_STATUSES = ["pending", "resolved", "dismissed"];
const MANAGED_REPORT_STATUSES = ["pending", "dismissed"];
const USER_ROLES = ["user", "moderator", "admin"];

router.use(requireModerator);

function cleanNote(body, { required = false, minimum = 1, maximum = 500 } = {}) {
  const note = typeof body?.note === "string" ? body.note.trim() : "";
  if (required && note.length < minimum) {
    return { error: `Add a note with at least ${minimum} characters` };
  }
  if (note.length > maximum) {
    return { error: `Notes cannot exceed ${maximum} characters` };
  }
  return { note };
}

function actorFrom(request) {
  return {
    actorId: request.auth.user.id,
    actorName: (request.auth.user.name || request.auth.user.email || "Moderator").trim().slice(0, 160),
    actorRole: request.auth.effectiveRole,
  };
}

function serializeAction(action) {
  return {
    id: String(action._id),
    action: action.action,
    actorName: action.actorName,
    actorRole: action.actorRole,
    note: action.note,
    changedFields: action.changedFields || [],
    previousRole: action.previousRole || null,
    newRole: action.newRole || null,
    createdAt: action.createdAt,
  };
}

function serializeUser(user, history = []) {
  return {
    id: user.id,
    name: user.name || "Community member",
    email: user.email,
    emailVerified: Boolean(user.emailVerified),
    role: USER_ROLES.includes(user.role) ? user.role : "user",
    banned: Boolean(user.banned),
    banReason: user.banReason || "",
    banExpires: user.banExpires || null,
    createdAt: user.createdAt,
    history: history.map(serializeAction),
  };
}

function sendAuthError(error, response, next) {
  if (Number.isInteger(error?.statusCode) && error.statusCode >= 400 && error.statusCode < 500) {
    return response.status(error.statusCode).json({ message: error.body?.message || error.message });
  }
  return next(error);
}

async function findReport(response, id, { pending = false } = {}) {
  if (!mongoose.isValidObjectId(id)) {
    response.status(400).json({ message: "Invalid report" });
    return null;
  }
  const report = await Report.findById(id);
  if (!report) {
    response.status(404).json({ message: "Report not found" });
    return null;
  }
  if (pending && report.status !== "pending") {
    response.status(409).json({ message: "Reopen this report before taking another content action" });
    return null;
  }
  return report;
}

router.get("/reports", async (request, response, next) => {
  try {
    const status = REPORT_STATUSES.includes(request.query.status) ? request.query.status : "pending";
    const reports = await Report.find({ status }).sort({ createdAt: -1 }).limit(100).lean();
    const pollSlugs = [...new Set(reports.map((report) => report.pollSlug))];
    const reportIds = reports.map((report) => report._id);
    const [polls, actions] = await Promise.all([
      pollSlugs.length ? Poll.find({ slug: { $in: pollSlugs } }).lean() : [],
      reportIds.length
        ? ModerationAction.find({ reportId: { $in: reportIds } }).sort({ createdAt: 1 }).lean()
        : [],
    ]);
    const pollsBySlug = new Map(polls.map((poll) => [poll.slug, poll]));
    const actionsByReport = new Map();
    for (const action of actions) {
      const key = String(action.reportId);
      actionsByReport.set(key, [...(actionsByReport.get(key) || []), serializeAction(action)]);
    }

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
          history: actionsByReport.get(String(report._id)) || [],
          poll: poll
            ? {
                question: poll.question,
                category: poll.category,
                options: poll.options.map((option) => ({
                  id: String(option._id),
                  label: option.label,
                  votes: option.votes,
                })),
                totalVotes: poll.totalVotes,
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
    const status = request.body?.status;
    if (!MANAGED_REPORT_STATUSES.includes(status)) {
      return response.status(400).json({
        message: "Dismiss the report to keep the poll, or use an edit/remove action to resolve it",
      });
    }
    const { note, error } = cleanNote(request.body);
    if (error) return response.status(400).json({ message: error });
    const report = await findReport(response, request.params.id);
    if (!report) return undefined;

    report.status = status;
    report.reviewedBy = status === "dismissed" ? request.auth.user.id : null;
    report.reviewedAt = status === "dismissed" ? new Date() : null;
    await report.save();
    await ModerationAction.create({
      ...actorFrom(request),
      action: status === "dismissed" ? "report_dismissed" : "report_reopened",
      reportId: report._id,
      pollSlug: report.pollSlug,
      note,
    });
    return response.json({ message: status === "dismissed" ? "Report dismissed" : "Report reopened" });
  } catch (error) {
    return next(error);
  }
});

router.post("/reports/:id/notes", limitWrites, async (request, response, next) => {
  try {
    const { note, error } = cleanNote(request.body, { required: true, minimum: 2 });
    if (error) return response.status(400).json({ message: error });
    const report = await findReport(response, request.params.id);
    if (!report) return undefined;

    const action = await ModerationAction.create({
      ...actorFrom(request),
      action: "note_added",
      reportId: report._id,
      pollSlug: report.pollSlug,
      note,
    });
    return response.status(201).json({ action: serializeAction(action) });
  } catch (error) {
    return next(error);
  }
});

router.patch("/reports/:id/poll", limitWrites, async (request, response, next) => {
  try {
    const { note, error } = cleanNote(request.body, { required: true, minimum: 3 });
    if (error) return response.status(400).json({ message: error });
    const { errors, value } = validatePoll(request.body);
    if (errors.length) return response.status(400).json({ message: errors[0], errors });
    const report = await findReport(response, request.params.id, { pending: true });
    if (!report) return undefined;
    const poll = await Poll.findOne({ slug: report.pollSlug, deletedAt: null });
    if (!poll) return response.status(404).json({ message: "Poll not found" });
    if (poll.totalVotes > 0 && value.options.length !== poll.options.length) {
      return response.status(409).json({
        message: "Answer options cannot be added or removed after voting has started",
      });
    }

    const oldLabels = poll.options.map((option) => option.label);
    const changedFields = [];
    if (poll.question !== value.question) changedFields.push("question");
    if (poll.category !== value.category) changedFields.push("category");
    if (oldLabels.some((label, index) => label !== value.options[index]) || oldLabels.length !== value.options.length) {
      changedFields.push("answer options");
    }
    if (!changedFields.length) return response.status(400).json({ message: "Change at least one poll field" });

    const options = value.options.map((label, index) => {
      const existing = poll.options[index];
      return existing
        ? { _id: existing._id, label, votes: existing.votes }
        : { label, votes: 0 };
    });
    const updatedPoll = await Poll.findOneAndUpdate(
      { _id: poll._id, deletedAt: null },
      { $set: { question: value.question, category: value.category, options } },
      { returnDocument: "after", runValidators: true },
    );
    if (!updatedPoll) return response.status(409).json({ message: "Poll changed while it was being reviewed" });

    report.status = "resolved";
    report.reviewedBy = request.auth.user.id;
    report.reviewedAt = new Date();
    await report.save();
    await ModerationAction.create({
      ...actorFrom(request),
      action: "poll_edited",
      reportId: report._id,
      pollSlug: report.pollSlug,
      targetUserId: poll.creatorId || null,
      note,
      changedFields,
    });
    return response.json({ message: "Poll edited and report resolved" });
  } catch (error) {
    return next(error);
  }
});

router.post("/reports/:id/remove-poll", limitWrites, async (request, response, next) => {
  try {
    const { note, error } = cleanNote(request.body);
    if (error) return response.status(400).json({ message: error });
    const report = await findReport(response, request.params.id, { pending: true });
    if (!report) return undefined;
    const poll = await Poll.findOne({ slug: report.pollSlug });

    await Poll.findOneAndUpdate(
      { slug: report.pollSlug, deletedAt: null },
      { $set: { status: "archived", deletedAt: new Date() } },
    );
    report.status = "resolved";
    report.reviewedBy = request.auth.user.id;
    report.reviewedAt = new Date();
    await report.save();
    await ModerationAction.create({
      ...actorFrom(request),
      action: "poll_removed",
      reportId: report._id,
      pollSlug: report.pollSlug,
      targetUserId: poll?.creatorId || null,
      note,
    });
    return response.json({ message: "Poll removed and report resolved" });
  } catch (error) {
    return next(error);
  }
});

router.post("/reports/:id/suspend-owner", requireAdmin, limitWrites, async (request, response, next) => {
  try {
    const { note, error } = cleanNote(request.body);
    if (error) return response.status(400).json({ message: error });
    const report = await findReport(response, request.params.id, { pending: true });
    if (!report) return undefined;
    const poll = await Poll.findOne({ slug: report.pollSlug });
    if (!poll?.creatorId) {
      return response.status(409).json({ message: "This legacy poll has no account owner" });
    }
    if (poll.creatorId === request.auth.user.id) {
      return response.status(400).json({ message: "You cannot suspend your own account" });
    }

    const reason = note || `Poll moderation: ${report.reason}`;
    await auth.api.banUser({
      body: { userId: poll.creatorId, banReason: reason.slice(0, 200) },
      headers: fromNodeHeaders(request.headers),
    });
    await ModerationAction.create({
      ...actorFrom(request),
      action: "owner_suspended",
      reportId: report._id,
      pollSlug: report.pollSlug,
      targetUserId: poll.creatorId,
      note: reason,
    });
    return response.json({ message: "Poll owner suspended" });
  } catch (error) {
    return sendAuthError(error, response, next);
  }
});

router.get("/users", requireAdmin, async (request, response, next) => {
  try {
    const page = Number(request.query.page || 1);
    const searchField = request.query.field === "email" ? "email" : "name";
    const searchValue = typeof request.query.q === "string" ? request.query.q.trim().slice(0, 160) : "";
    if (!Number.isSafeInteger(page) || page < 1 || page > 10000) {
      return response.status(400).json({ message: "Page must be between 1 and 10000" });
    }
    const limit = 20;
    const result = await auth.api.listUsers({
      query: {
        limit,
        offset: (page - 1) * limit,
        sortBy: "createdAt",
        sortDirection: "desc",
        ...(searchValue ? { searchValue, searchField, searchOperator: "contains" } : {}),
      },
      headers: fromNodeHeaders(request.headers),
    });
    const userIds = result.users.map((user) => user.id);
    const actions = userIds.length
      ? await ModerationAction.find({ targetUserId: { $in: userIds } }).sort({ createdAt: -1 }).limit(200).lean()
      : [];
    const historyByUser = new Map();
    for (const action of actions) {
      const history = historyByUser.get(action.targetUserId) || [];
      if (history.length < 5) history.push(action);
      historyByUser.set(action.targetUserId, history);
    }

    return response.json({
      users: result.users.map((user) => serializeUser(user, historyByUser.get(user.id) || [])),
      total: result.total,
      page,
      pages: Math.max(1, Math.ceil(result.total / limit)),
      selfId: request.auth.user.id,
    });
  } catch (error) {
    return sendAuthError(error, response, next);
  }
});

router.patch("/users/:id/role", requireAdmin, limitWrites, async (request, response, next) => {
  try {
    const role = request.body?.role;
    if (!USER_ROLES.includes(role)) {
      return response.status(400).json({ message: "Choose a valid role" });
    }
    if (request.params.id === request.auth.user.id) {
      return response.status(400).json({ message: "Another administrator must change your role" });
    }
    const headers = fromNodeHeaders(request.headers);
    const currentUser = await auth.api.getUser({ query: { id: request.params.id }, headers });
    const previousRole = USER_ROLES.includes(currentUser.role) ? currentUser.role : "user";
    if (previousRole === role) return response.json({ user: serializeUser(currentUser) });

    const result = await auth.api.setRole({ body: { userId: request.params.id, role }, headers });
    await ModerationAction.create({
      ...actorFrom(request),
      action: "role_changed",
      targetUserId: request.params.id,
      previousRole,
      newRole: role,
      note: `Role changed from ${previousRole} to ${role}`,
    });
    return response.json({ user: serializeUser(result.user) });
  } catch (error) {
    return sendAuthError(error, response, next);
  }
});

router.post("/users/:id/suspend", requireAdmin, limitWrites, async (request, response, next) => {
  try {
    const { note, error } = cleanNote(request.body, { required: true, minimum: 3, maximum: 200 });
    if (error) return response.status(400).json({ message: error });
    if (request.params.id === request.auth.user.id) {
      return response.status(400).json({ message: "You cannot suspend your own account" });
    }
    const result = await auth.api.banUser({
      body: { userId: request.params.id, banReason: note },
      headers: fromNodeHeaders(request.headers),
    });
    await ModerationAction.create({
      ...actorFrom(request),
      action: "user_suspended",
      targetUserId: request.params.id,
      note,
    });
    return response.json({ user: serializeUser(result.user) });
  } catch (error) {
    return sendAuthError(error, response, next);
  }
});

router.post("/users/:id/reactivate", requireAdmin, limitWrites, async (request, response, next) => {
  try {
    const { note, error } = cleanNote(request.body);
    if (error) return response.status(400).json({ message: error });
    const result = await auth.api.unbanUser({
      body: { userId: request.params.id },
      headers: fromNodeHeaders(request.headers),
    });
    await ModerationAction.create({
      ...actorFrom(request),
      action: "user_reactivated",
      targetUserId: request.params.id,
      note,
    });
    return response.json({ user: serializeUser(result.user) });
  } catch (error) {
    return sendAuthError(error, response, next);
  }
});

export default router;
