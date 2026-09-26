import { Router } from "express";
import mongoose from "mongoose";

import { requireAdmin, requireModerator } from "../auth-middleware.js";
import { withDatabaseTransaction } from "../db.js";
import ModerationAction from "../models/ModerationAction.js";
import Poll from "../models/Poll.js";
import Report from "../models/Report.js";
import { limitWrites } from "../rate-limit.js";
import {
  findAuthUserById,
  listAuthUsers,
  reactivateAuthUser,
  setAuthUserRole,
  suspendAuthUser,
  UserAdminError,
} from "../services/user-admin.js";
import { validatePoll } from "../validation.js";

const router = Router();
const REPORT_STATUSES = ["pending", "resolved", "dismissed"];
const MANAGED_REPORT_STATUSES = ["pending", "dismissed"];
const USER_ROLES = ["user", "moderator", "admin"];

router.use(requireModerator);

class ModerationRequestError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "ModerationRequestError";
    this.status = status;
  }
}

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
    before: action.before || null,
    after: action.after || null,
    affectedReports: action.affectedReports ?? null,
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

function serializePoll(poll) {
  return {
    slug: poll.slug,
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
    moderatedAt: poll.moderatedAt || null,
    moderationEditCount: poll.moderationEditCount || 0,
  };
}

function pollSnapshot(poll) {
  if (!poll) return null;
  return {
    question: poll.question,
    category: poll.category,
    options: poll.options.map((option) => ({
      id: String(option._id),
      label: option.label,
      votes: option.votes,
    })),
    totalVotes: poll.totalVotes,
    status: poll.status || "active",
    deletedAt: poll.deletedAt || null,
  };
}

function withSession(query, session) {
  return session && typeof query?.session === "function" ? query.session(session) : query;
}

async function updatePollContent(poll, value, session) {
  const oldLabels = poll.options.map((option) => option.label);
  const changedFields = [];
  if (poll.question !== value.question) changedFields.push("question");
  if (poll.category !== value.category) changedFields.push("category");
  if (oldLabels.some((label, index) => label !== value.options[index]) || oldLabels.length !== value.options.length) {
    changedFields.push("answer options");
  }
  if (!changedFields.length) throw new ModerationRequestError("Change at least one poll field");
  if (poll.totalVotes > 0 && changedFields.some((field) => field !== "category")) {
    throw new ModerationRequestError(
      "The question and answer options are locked after voting starts. Remove the poll if its meaning is unsafe.",
      409,
    );
  }

  const options = value.options.map((label, index) => {
    const existing = poll.options[index];
    return existing
      ? { _id: existing._id, label, votes: existing.votes }
      : { label, votes: 0 };
  });
  const concurrencyFilter = { _id: poll._id, deletedAt: null };
  if (poll.updatedAt) concurrencyFilter.updatedAt = poll.updatedAt;
  const updatedPoll = await Poll.findOneAndUpdate(
    concurrencyFilter,
    {
      $set: {
        question: value.question,
        category: value.category,
        options,
        moderatedAt: new Date(),
      },
      $inc: { moderationEditCount: 1 },
    },
    { returnDocument: "after", runValidators: true, session },
  );
  if (!updatedPoll) throw new ModerationRequestError("Poll changed while it was being reviewed", 409);
  return { updatedPoll, changedFields, before: pollSnapshot(poll), after: pollSnapshot(updatedPoll) };
}

function sendAdminError(error, response, next) {
  if (error instanceof UserAdminError || error instanceof ModerationRequestError) {
    return response.status(error.status).json({ message: error.message });
  }
  return next(error);
}

async function createAction(data, session) {
  if (!session) return ModerationAction.create(data);
  const [action] = await ModerationAction.create([data], { session });
  return action;
}

async function findReport(id, { pending = false, session } = {}) {
  if (!mongoose.isValidObjectId(id)) {
    throw new ModerationRequestError("Invalid report");
  }
  const report = await withSession(Report.findById(id), session);
  if (!report) throw new ModerationRequestError("Report not found", 404);
  if (pending && report.status !== "pending") {
    throw new ModerationRequestError("Reopen this report before taking another content action", 409);
  }
  return report;
}

async function resolvePendingReports({ pollSlug, action, actor, targetUserId, note, before, after, session }) {
  const reports = await withSession(Report.find({ pollSlug, status: "pending" }), session);
  if (!reports.length) throw new ModerationRequestError("This report has already been handled", 409);
  const reviewedAt = new Date();
  await Report.updateMany(
    { _id: { $in: reports.map((report) => report._id) }, status: "pending" },
    { $set: { status: "resolved", reviewedBy: actor.actorId, reviewedAt } },
    { session },
  );
  for (const report of reports) {
    await createAction({
      ...actor,
      action,
      reportId: report._id,
      pollSlug,
      targetUserId,
      note,
      before,
      after,
      affectedReports: reports.length,
    }, session);
  }
  return reports.length;
}

router.get("/polls/:slug", async (request, response, next) => {
  try {
    const poll = await Poll.findOne({ slug: request.params.slug, deletedAt: null });
    if (!poll) return response.status(404).json({ message: "Poll not found" });
    const history = await ModerationAction.find({
      pollSlug: poll.slug,
      action: "poll_edited",
    }).sort({ createdAt: -1 }).limit(50).lean();
    return response.json({ poll: serializePoll(poll), history: history.map(serializeAction) });
  } catch (error) {
    return next(error);
  }
});

router.patch("/polls/:slug", limitWrites, async (request, response, next) => {
  try {
    const { note, error } = cleanNote(request.body, { required: true, minimum: 3 });
    if (error) return response.status(400).json({ message: error });
    const { errors, value } = validatePoll(request.body);
    if (errors.length) return response.status(400).json({ message: errors[0], errors });
    const result = await withDatabaseTransaction(async (session) => {
      const poll = await withSession(
        Poll.findOne({ slug: request.params.slug, deletedAt: null }),
        session,
      );
      if (!poll) throw new ModerationRequestError("Poll not found", 404);
      const update = await updatePollContent(poll, value, session);
      const action = await createAction({
        ...actorFrom(request),
        action: "poll_edited",
        pollSlug: poll.slug,
        targetUserId: poll.creatorId || null,
        note,
        changedFields: update.changedFields,
        before: update.before,
        after: update.after,
      }, session);
      return { ...update, action };
    });
    return response.json({
      message: "Poll changes saved",
      poll: serializePoll(result.updatedPoll),
      action: serializeAction(result.action),
    });
  } catch (error) {
    return sendAdminError(error, response, next);
  }
});

router.get("/reports", async (request, response, next) => {
  try {
    const status = REPORT_STATUSES.includes(request.query.status) ? request.query.status : "pending";
    const page = Number(request.query.page || 1);
    if (!Number.isSafeInteger(page) || page < 1 || page > 10000) {
      return response.status(400).json({ message: "Page must be between 1 and 10000" });
    }
    const limit = 25;
    const [reports, total] = await Promise.all([
      Report.find({ status }).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      Report.countDocuments({ status }),
    ]);
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
      total,
      page,
      pages: Math.max(1, Math.ceil(total / limit)),
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
          poll: poll ? serializePoll(poll) : null,
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
    const { note, error } = cleanNote(request.body, { required: true, minimum: 3 });
    if (error) return response.status(400).json({ message: error });
    await withDatabaseTransaction(async (session) => {
      const report = await findReport(request.params.id, { session });
      report.status = status;
      report.reviewedBy = status === "dismissed" ? request.auth.user.id : null;
      report.reviewedAt = status === "dismissed" ? new Date() : null;
      await report.save({ session });
      await createAction({
        ...actorFrom(request),
        action: status === "dismissed" ? "report_dismissed" : "report_reopened",
        reportId: report._id,
        pollSlug: report.pollSlug,
        note,
      }, session);
    });
    return response.json({ message: status === "dismissed" ? "Report dismissed" : "Report reopened" });
  } catch (error) {
    return sendAdminError(error, response, next);
  }
});

router.post("/reports/:id/notes", limitWrites, async (request, response, next) => {
  try {
    const { note, error } = cleanNote(request.body, { required: true, minimum: 2 });
    if (error) return response.status(400).json({ message: error });
    const report = await findReport(request.params.id);

    const action = await ModerationAction.create({
      ...actorFrom(request),
      action: "note_added",
      reportId: report._id,
      pollSlug: report.pollSlug,
      note,
    });
    return response.status(201).json({ action: serializeAction(action) });
  } catch (error) {
    return sendAdminError(error, response, next);
  }
});

router.patch("/reports/:id/poll", limitWrites, async (request, response, next) => {
  try {
    const { note, error } = cleanNote(request.body, { required: true, minimum: 3 });
    if (error) return response.status(400).json({ message: error });
    const { errors, value } = validatePoll(request.body);
    if (errors.length) return response.status(400).json({ message: errors[0], errors });
    const affectedReports = await withDatabaseTransaction(async (session) => {
      const report = await findReport(request.params.id, { pending: true, session });
      const poll = await withSession(
        Poll.findOne({ slug: report.pollSlug, deletedAt: null }),
        session,
      );
      if (!poll) throw new ModerationRequestError("Poll not found", 404);
      const result = await updatePollContent(poll, value, session);
      return resolvePendingReports({
        pollSlug: report.pollSlug,
        action: "poll_edited",
        actor: actorFrom(request),
        targetUserId: poll.creatorId || null,
        note,
        before: result.before,
        after: result.after,
        session,
      });
    });
    return response.json({
      message: affectedReports === 1
        ? "Poll edited and report resolved"
        : `Poll edited and ${affectedReports} related reports resolved`,
      affectedReports,
    });
  } catch (error) {
    return sendAdminError(error, response, next);
  }
});

router.post("/reports/:id/remove-poll", limitWrites, async (request, response, next) => {
  try {
    const { note, error } = cleanNote(request.body, { required: true, minimum: 3 });
    if (error) return response.status(400).json({ message: error });
    const affectedReports = await withDatabaseTransaction(async (session) => {
      const report = await findReport(request.params.id, { pending: true, session });
      const poll = await withSession(Poll.findOne({ slug: report.pollSlug }), session);
      if (!poll) throw new ModerationRequestError("Poll not found", 404);
      const before = pollSnapshot(poll);
      const removedPoll = await Poll.findOneAndUpdate(
        { _id: poll._id, deletedAt: null },
        { $set: { status: "archived", deletedAt: new Date() } },
        { returnDocument: "after", session },
      );
      if (!removedPoll) throw new ModerationRequestError("Poll changed while it was being reviewed", 409);
      return resolvePendingReports({
        pollSlug: report.pollSlug,
        action: "poll_removed",
        actor: actorFrom(request),
        targetUserId: poll.creatorId || null,
        note,
        before,
        after: pollSnapshot(removedPoll),
        session,
      });
    });
    return response.json({
      message: affectedReports === 1
        ? "Poll removed and report resolved"
        : `Poll removed and ${affectedReports} related reports resolved`,
      affectedReports,
    });
  } catch (error) {
    return sendAdminError(error, response, next);
  }
});

router.post("/reports/:id/suspend-owner", requireAdmin, limitWrites, async (request, response, next) => {
  try {
    const { note, error } = cleanNote(request.body);
    if (error) return response.status(400).json({ message: error });
    const result = await withDatabaseTransaction(async (session) => {
      const report = await findReport(request.params.id, { pending: true, session });
      const poll = await withSession(Poll.findOne({ slug: report.pollSlug }), session);
      if (!poll?.creatorId) {
        throw new ModerationRequestError("This legacy poll has no account owner", 409);
      }
      if (poll.creatorId === request.auth.user.id) {
        throw new ModerationRequestError("You cannot suspend your own account");
      }

      const reason = (note || `Poll moderation: ${report.reason}`).slice(0, 200);
      await suspendAuthUser(poll.creatorId, reason, { session });
      const affectedReports = await resolvePendingReports({
        pollSlug: report.pollSlug,
        action: "owner_suspended",
        actor: actorFrom(request),
        targetUserId: poll.creatorId,
        note: reason,
        before: pollSnapshot(poll),
        after: pollSnapshot(poll),
        session,
      });
      return { affectedReports };
    });
    return response.json({ message: "Poll owner suspended and report resolved", affectedReports: result.affectedReports });
  } catch (error) {
    return sendAdminError(error, response, next);
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
    const result = await listAuthUsers({ page, limit, searchField, searchValue });
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
    return sendAdminError(error, response, next);
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
    const currentUser = await findAuthUserById(request.params.id);
    if (!currentUser) return response.status(404).json({ message: "User not found" });
    const previousRole = USER_ROLES.includes(currentUser.role) ? currentUser.role : "user";
    if (previousRole === role) return response.json({ user: serializeUser(currentUser) });

    const user = await withDatabaseTransaction(async (session) => {
      const updated = await setAuthUserRole(request.params.id, role, { session });
      await createAction({
        ...actorFrom(request),
        action: "role_changed",
        targetUserId: request.params.id,
        previousRole,
        newRole: role,
        note: `Role changed from ${previousRole} to ${role}; active sessions revoked`,
      }, session);
      return updated;
    });
    return response.json({ user: serializeUser(user) });
  } catch (error) {
    return sendAdminError(error, response, next);
  }
});

router.post("/users/:id/suspend", requireAdmin, limitWrites, async (request, response, next) => {
  try {
    const { note, error } = cleanNote(request.body, { required: true, minimum: 3, maximum: 200 });
    if (error) return response.status(400).json({ message: error });
    if (request.params.id === request.auth.user.id) {
      return response.status(400).json({ message: "You cannot suspend your own account" });
    }
    const user = await withDatabaseTransaction(async (session) => {
      const updated = await suspendAuthUser(request.params.id, note, { session });
      await createAction({
        ...actorFrom(request),
        action: "user_suspended",
        targetUserId: request.params.id,
        note,
      }, session);
      return updated;
    });
    return response.json({ user: serializeUser(user) });
  } catch (error) {
    return sendAdminError(error, response, next);
  }
});

router.post("/users/:id/reactivate", requireAdmin, limitWrites, async (request, response, next) => {
  try {
    const { note, error } = cleanNote(request.body);
    if (error) return response.status(400).json({ message: error });
    const user = await withDatabaseTransaction(async (session) => {
      const updated = await reactivateAuthUser(request.params.id, { session });
      await createAction({
        ...actorFrom(request),
        action: "user_reactivated",
        targetUserId: request.params.id,
        note,
      }, session);
      return updated;
    });
    return response.json({ user: serializeUser(user) });
  } catch (error) {
    return sendAdminError(error, response, next);
  }
});

export default router;
