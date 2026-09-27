import { Router } from "express";
import mongoose from "mongoose";

import { requireAdmin, requireModerator } from "../auth-middleware.js";
import { withIdentityTransaction } from "../services/identity-transaction.js";
import ModerationAction from "../models/ModerationAction.js";
import Poll from "../models/Poll.js";
import Report from "../models/Report.js";
import RecoveryRequest from "../models/RecoveryRequest.js";
import AuthUser from "../models/AuthUser.js";
import { approveRecovery } from "../services/account-recovery.js";
import { paginateStaff, StaffPaginationError } from "../services/staff-pagination.js";
import { limitAccountReads, limitWrites } from "../rate-limit.js";
import {
  findAuthUserById,
  idCandidates,
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

router.use((_request, response, next) => {
  response.set("Cache-Control", "private, no-store");
  next();
});
router.use(requireModerator);
router.use(limitAccountReads);

router.get("/recovery", requireAdmin, async (request, response, next) => {
  try {
    const after = request.query.after;
    if (after !== undefined && (typeof after !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(after))) return response.status(400).json({ message: "Invalid recovery cursor" });
    const rows = await RecoveryRequest.find({ status: "pending", expiresAt: { $gt: new Date() }, ...(after ? { _id: { $gt: after } } : {}) })
      .sort({ _id: 1 }).limit(26).maxTimeMS(5000).lean();
    const requests = rows.slice(0, 25);
    const users = await AuthUser.find({ _id: { $in: requests.flatMap((row) => idCandidates(row._id)) } }).select("name email").lean();
    const names = new Map(users.map((user) => [String(user._id), user]));
    return response.json({ requests: requests.map((row) => ({
      userId: row._id, requestId: row.requestId, createdAt: row.createdAt, expiresAt: row.expiresAt,
      name: names.get(row._id)?.name || "Unavailable account", email: names.get(row._id)?.email || "",
      self: row._id === request.auth.user.id,
    })), nextCursor: rows.length > 25 ? requests.at(-1)._id : null });
  } catch (error) { return next(error); }
});

router.post("/recovery/:id/approve", requireAdmin, limitWrites, async (request, response, next) => {
  try {
    const { note, error } = cleanNote(request.body, { required: true, minimum: 10 });
    if (error || request.body?.identityConfirmed !== true || !/^[a-f0-9-]{36}$/.test(request.params.id)) {
      return response.status(400).json({ message: error || "Independently verify the account owner and confirm the recovery request" });
    }
    const result = await approveRecovery(request.auth, request.params.id, note);
    return response.json({ ...result, message: "Recovery approved. The owner must sign in again and enroll a new authenticator before using staff tools." });
  } catch (error) { return sendAdminError(error, response, next); }
});

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

function withStaffTransaction(request, work, role = "staff") {
  return withIdentityTransaction(request.auth, (session, { user, effectiveRole }) => work(session, {
    actorId: String(user._id),
    actorName: (user.name || user.email || "Moderator").trim().slice(0, 160),
    actorRole: effectiveRole,
  }), { role, adminChanges: role === "admin" });
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
    pollSlug: action.pollSlug || null,
    reportId: action.reportId ? String(action.reportId) : null,
    targetUserId: action.targetUserId || null,
    createdAt: action.createdAt,
  };
}

function serializeUser(user) {
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
  if (error instanceof StaffPaginationError) return response.status(400).json({ message: error.message });
  if (error?.code === 11000) {
    return response.status(409).json({ message: "A pending report from this reporter already exists. Review that report before reopening this one." });
  }
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

async function resolvePendingReports({ pollSlug, action, actor, targetUserId, note, before, after, changedFields = [], session }) {
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
      changedFields,
      affectedReports: reports.length,
    }, session);
  }
  return reports.length;
}

router.get("/polls/:slug", async (request, response, next) => {
  try {
    const poll = await Poll.findOne({ slug: request.params.slug, deletedAt: null });
    if (!poll) return response.status(404).json({ message: "Poll not found" });
    return response.json({ poll: serializePoll(poll) });
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
    const result = await withStaffTransaction(request, async (session, actor) => {
      const poll = await withSession(
        Poll.findOne({ slug: request.params.slug, deletedAt: null }),
        session,
      );
      if (!poll) throw new ModerationRequestError("Poll not found", 404);
      const update = await updatePollContent(poll, value, session);
      const action = await createAction({
        ...actor,
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
    const { items: reports, nextCursor } = await paginateStaff(Report, {
      query: request.query, filter: { status }, scope: `reports:${status}`,
      select: "pollSlug reason details status createdAt",
    });
    const pollSlugs = [...new Set(reports.map((report) => report.pollSlug))];
    const polls = pollSlugs.length ? await Poll.find({ slug: { $in: pollSlugs } }).maxTimeMS(5000).lean() : [];
    const pollsBySlug = new Map(polls.map((poll) => [poll.slug, poll]));

    return response.json({
      role: request.auth.effectiveRole,
      nextCursor,
      reports: reports.map((report) => {
        const poll = pollsBySlug.get(report.pollSlug);
        return {
          id: String(report._id),
          pollSlug: report.pollSlug,
          reason: report.reason,
          details: report.details,
          status: report.status,
          createdAt: report.createdAt,
          poll: poll ? serializePoll(poll) : null,
        };
      }),
    });
  } catch (error) {
    return sendAdminError(error, response, next);
  }
});

function historyHandler(filterFrom, scopeFrom) {
  return async (request, response, next) => {
    try {
      const result = await paginateStaff(ModerationAction, {
        query: request.query, filter: filterFrom(request), scope: scopeFrom(request),
      });
      return response.json({ actions: result.items.map(serializeAction), nextCursor: result.nextCursor });
    } catch (error) { return sendAdminError(error, response, next); }
  };
}

// Histories intentionally survive soft removal or deletion of their subject.
// The global administrator log also exposes retained, anonymized old actions.
router.get("/history", requireAdmin, historyHandler(() => ({}), () => "history:all"));
router.get("/reports/:id/history", historyHandler((request) => {
  if (!mongoose.isValidObjectId(request.params.id)) throw new ModerationRequestError("Invalid report");
  return { reportId: request.params.id };
}, (request) => `history:report:${request.params.id}`));
router.get("/polls/:slug/history", historyHandler((request) => ({ pollSlug: request.params.slug }), (request) => `history:poll:${request.params.slug}`));
router.get("/users/:id/history", requireAdmin, historyHandler((request) => ({ targetUserId: request.params.id }), (request) => `history:user:${request.params.id}`));

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
    await withStaffTransaction(request, async (session, actor) => {
      const report = await findReport(request.params.id, { session });
      if (report.status === status) return;
      report.status = status;
      report.reviewedBy = status === "dismissed" ? request.auth.user.id : null;
      report.reviewedAt = status === "dismissed" ? new Date() : null;
      await report.save({ session });
      await createAction({
        ...actor,
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
    const action = await withStaffTransaction(request, async (session, actor) => {
      const report = await findReport(request.params.id, { session });
      return createAction({
        ...actor,
        action: "note_added",
        reportId: report._id,
        pollSlug: report.pollSlug,
        note,
      }, session);
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
    const affectedReports = await withStaffTransaction(request, async (session, actor) => {
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
        actor,
        targetUserId: poll.creatorId || null,
        note,
        before: result.before,
        after: result.after,
        changedFields: result.changedFields,
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
    const affectedReports = await withStaffTransaction(request, async (session, actor) => {
      const report = await findReport(request.params.id, { pending: true, session });
      const poll = await withSession(Poll.findOne({ slug: report.pollSlug }), session);
      const before = pollSnapshot(poll);
      const removedPoll = !poll || poll.deletedAt ? poll : await Poll.findOneAndUpdate(
        { _id: poll._id, deletedAt: null },
        { $set: { status: "archived", deletedAt: new Date() } },
        { returnDocument: "after", session },
      );
      if (poll && !removedPoll) throw new ModerationRequestError("Poll changed while it was being reviewed", 409);
      return resolvePendingReports({
        pollSlug: report.pollSlug,
        action: "poll_removed",
        actor,
        targetUserId: poll?.creatorId || null,
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
    await withStaffTransaction(request, async (session, actor) => {
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
      await createAction({
        pollSlug: report.pollSlug,
        reportId: report._id,
        action: "owner_suspended",
        ...actor,
        targetUserId: poll.creatorId,
        note: reason,
        before: pollSnapshot(poll),
        after: pollSnapshot(poll),
      }, session);
    }, "admin");
    return response.json({ message: "Poll owner suspended. Reports remain pending until the content is reviewed." });
  } catch (error) {
    return sendAdminError(error, response, next);
  }
});

router.get("/users", requireAdmin, async (request, response, next) => {
  try {
    const searchField = request.query.field === "email" ? "email" : "name";
    const searchValue = typeof request.query.q === "string" ? request.query.q.trim().slice(0, 160) : "";
    const result = await listAuthUsers({ query: request.query, searchField, searchValue });

    return response.json({
      users: result.users.map((user) => serializeUser(user)),
      nextCursor: result.nextCursor,
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
    const user = await withStaffTransaction(request, async (session, actor) => {
      const currentUser = await findAuthUserById(request.params.id, { session });
      if (!currentUser) throw new UserAdminError("User not found", 404);
      const previousRole = USER_ROLES.includes(currentUser.role) ? currentUser.role : "user";
      if (previousRole === role) return currentUser;
      const updated = await setAuthUserRole(request.params.id, role, { session });
      await createAction({
        ...actor,
        action: "role_changed",
        targetUserId: request.params.id,
        previousRole,
        newRole: role,
        note: `Role changed from ${previousRole} to ${role}; active sessions revoked`,
      }, session);
      return updated;
    }, "admin");
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
    const user = await withStaffTransaction(request, async (session, actor) => {
      const updated = await suspendAuthUser(request.params.id, note, { session });
      await createAction({
        ...actor,
        action: "user_suspended",
        targetUserId: request.params.id,
        note,
      }, session);
      return updated;
    }, "admin");
    return response.json({ user: serializeUser(user) });
  } catch (error) {
    return sendAdminError(error, response, next);
  }
});

router.post("/users/:id/reactivate", requireAdmin, limitWrites, async (request, response, next) => {
  try {
    const { note, error } = cleanNote(request.body);
    if (error) return response.status(400).json({ message: error });
    const user = await withStaffTransaction(request, async (session, actor) => {
      const updated = await reactivateAuthUser(request.params.id, { session });
      await createAction({
        ...actor,
        action: "user_reactivated",
        targetUserId: request.params.id,
        note,
      }, session);
      return updated;
    }, "admin");
    return response.json({ user: serializeUser(user) });
  } catch (error) {
    return sendAdminError(error, response, next);
  }
});

export default router;
