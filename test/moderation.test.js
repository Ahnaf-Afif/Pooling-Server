import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import express from "express";
import mongoose from "mongoose";

import { closeDatabases } from "../src/db.js";
import ModerationAction from "../src/models/ModerationAction.js";
import AuthSession from "../src/models/AuthSession.js";
import AuthUser from "../src/models/AuthUser.js";
import Poll from "../src/models/Poll.js";
import RateBucket from "../src/models/RateBucket.js";
import Report from "../src/models/Report.js";
import moderationRoutes from "../src/routes/moderation.js";

const reportId = new mongoose.Types.ObjectId();
const pollId = new mongoose.Types.ObjectId();
const optionIds = [new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId()];
const original = {
  reportFind: Report.find,
  reportFindById: Report.findById,
  reportCount: Report.countDocuments,
  reportUpdateMany: Report.updateMany,
  pollFind: Poll.find,
  pollFindOne: Poll.findOne,
  pollFindOneAndUpdate: Poll.findOneAndUpdate,
  actionFind: ModerationAction.find,
  actionCreate: ModerationAction.create,
  rateLimit: RateBucket.findOneAndUpdate,
  transaction: mongoose.connection.transaction,
  userFind: AuthUser.find,
  userCount: AuthUser.countDocuments,
  userFindOne: AuthUser.findOne,
  userFindOneAndUpdate: AuthUser.findOneAndUpdate,
  sessionDeleteMany: AuthSession.deleteMany,
};
const seen = {};
let currentPoll;
let currentReport;
let currentUser;
let server;
let baseUrl;

function queryResult(value) {
  return {
    sort() { return this; },
    skip() { return this; },
    limit() { return this; },
    session() { return this; },
    lean() { return Promise.resolve(value); },
    toArray() { return Promise.resolve(value); },
    then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); },
  };
}

function makeReport(status = "pending") {
  return {
    _id: reportId,
    pollSlug: "reported-poll",
    reason: "spam",
    details: "Repeated advertising",
    reporterKey: "private-reporter-key",
    reporterUserId: "private-reporter-user",
    status,
    reviewedBy: null,
    reviewedAt: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    async save() { return this; },
  };
}

function makePoll({ totalVotes = 7 } = {}) {
  return {
    _id: pollId,
    slug: "reported-poll",
    question: "Which tool do you use?",
    category: "Tech",
    creatorId: "poll-owner",
    totalVotes,
    status: "active",
    deletedAt: null,
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    options: [
      { _id: optionIds[0], label: "One", votes: totalVotes ? 3 : 0 },
      { _id: optionIds[1], label: "Two", votes: totalVotes ? 4 : 0 },
    ],
  };
}

function makeUser(overrides = {}) {
  return {
    _id: "member-1",
    name: "Member One",
    email: "member@example.com",
    image: "https://example.com/private-photo.jpg",
    emailVerified: true,
    role: "user",
    banned: false,
    createdAt: new Date("2026-01-02T00:00:00Z"),
    updatedAt: new Date("2026-01-02T00:00:00Z"),
    ...overrides,
  };
}

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => {
    const role = request.headers["x-test-role"] || "admin";
    request.auth = {
      user: { id: "admin-user", name: "Test Admin", email: "admin@example.com", role },
    };
    next();
  });
  app.use("/api/moderation", moderationRoutes);
  app.use((error, _request, response, _next) => response.status(500).json({ message: error.message }));
  await new Promise((resolve, reject) => {
    server = app.listen(0, "127.0.0.1");
    server.once("listening", resolve);
    server.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(() => {
  for (const key of Object.keys(seen)) delete seen[key];
  currentPoll = makePoll();
  currentReport = makeReport();
  currentUser = makeUser();

  mongoose.connection.transaction = async (work) => work({ testSession: true });
  Report.find = () => queryResult([currentReport]);
  Report.findById = () => queryResult(currentReport);
  Report.countDocuments = async () => 1;
  Report.updateMany = async (_filter, update) => {
    Object.assign(currentReport, update.$set);
    seen.reportUpdate = update;
    return { modifiedCount: 1 };
  };
  Poll.find = () => queryResult([currentPoll]);
  Poll.findOne = () => queryResult(currentPoll);
  Poll.findOneAndUpdate = async (filter, update) => {
    seen.pollFilter = filter;
    seen.pollUpdate = update;
    currentPoll = {
      ...currentPoll,
      ...(update.$set || {}),
      moderationEditCount: (currentPoll.moderationEditCount || 0) + (update.$inc?.moderationEditCount || 0),
    };
    return currentPoll;
  };
  ModerationAction.find = () => queryResult([]);
  ModerationAction.create = async (data) => {
    const actionData = Array.isArray(data) ? data[0] : data;
    const action = { _id: new mongoose.Types.ObjectId(), createdAt: new Date(), ...actionData };
    seen.actions = [...(seen.actions || []), actionData];
    seen.action = actionData;
    return Array.isArray(data) ? [action] : action;
  };
  RateBucket.findOneAndUpdate = async () => ({ count: 1 });

  AuthUser.find = () => queryResult([currentUser]);
  AuthUser.countDocuments = async (filter) => filter?.role ? 2 : 1;
  AuthUser.findOne = () => queryResult(currentUser);
  AuthUser.findOneAndUpdate = (_filter, update) => {
    currentUser = { ...currentUser, ...(update.$set || {}) };
    for (const key of Object.keys(update.$unset || {})) delete currentUser[key];
    return queryResult(currentUser);
  };
  AuthSession.deleteMany = async () => {
    seen.sessionsRevoked = true;
    return { deletedCount: 1 };
  };
});

after(async () => {
  await new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  });
  Report.find = original.reportFind;
  Report.findById = original.reportFindById;
  Report.countDocuments = original.reportCount;
  Report.updateMany = original.reportUpdateMany;
  Poll.find = original.pollFind;
  Poll.findOne = original.pollFindOne;
  Poll.findOneAndUpdate = original.pollFindOneAndUpdate;
  ModerationAction.find = original.actionFind;
  ModerationAction.create = original.actionCreate;
  RateBucket.findOneAndUpdate = original.rateLimit;
  mongoose.connection.transaction = original.transaction;
  AuthUser.find = original.userFind;
  AuthUser.countDocuments = original.userCount;
  AuthUser.findOne = original.userFindOne;
  AuthUser.findOneAndUpdate = original.userFindOneAndUpdate;
  AuthSession.deleteMany = original.sessionDeleteMany;
  await closeDatabases();
});

test("keeps reporter identity private and paginates the moderation queue", async () => {
  const response = await fetch(`${baseUrl}/api/moderation/reports`);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.reports[0].reporterKey, undefined);
  assert.equal(data.reports[0].reporterUserId, undefined);
  assert.equal(data.reports[0].poll.options[0].votes, 3);
  assert.equal(data.page, 1);
  assert.equal(data.pages, 1);
});

test("does not resolve a report without a content decision", async () => {
  const response = await fetch(`${baseUrl}/api/moderation/reports/${reportId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "resolved" }),
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).message, /edit\/remove action/);
});

test("locks semantic poll content after voting starts", async () => {
  const response = await fetch(`${baseUrl}/api/moderation/reports/${reportId}/poll`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "x-test-role": "moderator" },
    body: JSON.stringify({
      question: "Which tool is safest to use?",
      category: "Tech",
      options: ["First", "Second"],
      note: "Removed unsafe wording",
    }),
  });
  assert.equal(response.status, 409);
  assert.match((await response.json()).message, /locked after voting starts/);
  assert.equal(seen.action, undefined);
});

test("moderators can correct a category and resolve related pending reports", async () => {
  const response = await fetch(`${baseUrl}/api/moderation/reports/${reportId}/poll`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "x-test-role": "moderator" },
    body: JSON.stringify({
      question: currentPoll.question,
      category: "Education",
      options: ["One", "Two"],
      note: "Corrected the category",
    }),
  });
  assert.equal(response.status, 200);
  assert.equal(currentReport.status, "resolved");
  assert.equal(seen.action.action, "poll_edited");
  assert.equal(seen.action.before.category, "Tech");
  assert.equal(seen.action.after.category, "Education");
});

test("moderators can directly edit an unvoted poll with content snapshots", async () => {
  currentPoll = makePoll({ totalVotes: 0 });
  const response = await fetch(`${baseUrl}/api/moderation/polls/reported-poll`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "x-test-role": "moderator" },
    body: JSON.stringify({
      question: "Which reviewed tool do you use?",
      category: "Tech",
      options: ["First", "Second"],
      note: "Corrected the unsafe title",
    }),
  });
  assert.equal(response.status, 200);
  assert.equal(seen.action.action, "poll_edited");
  assert.equal(seen.action.reportId, undefined);
  assert.equal(seen.action.before.options[0].label, "One");
  assert.equal(seen.action.after.options[0].label, "First");
});

test("removing a poll resolves reports and records content snapshots", async () => {
  const response = await fetch(`${baseUrl}/api/moderation/reports/${reportId}/remove-poll`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-test-role": "moderator" },
    body: JSON.stringify({ note: "Confirmed promotional spam" }),
  });
  assert.equal(response.status, 200);
  assert.equal(currentReport.status, "resolved");
  assert.equal(seen.pollUpdate.$set.status, "archived");
  assert.ok(seen.pollUpdate.$set.deletedAt instanceof Date);
  assert.equal(seen.action.action, "poll_removed");
  assert.equal(seen.action.before.deletedAt, null);
  assert.ok(seen.action.after.deletedAt);
});

test("adds internal notes to a report audit history", async () => {
  const response = await fetch(`${baseUrl}/api/moderation/reports/${reportId}/notes`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-test-role": "moderator" },
    body: JSON.stringify({ note: "Waiting for a second review" }),
  });
  assert.equal(response.status, 201);
  assert.equal(seen.action.action, "note_added");
});

test("suspending a poll owner resolves the related report atomically", async () => {
  const response = await fetch(`${baseUrl}/api/moderation/reports/${reportId}/suspend-owner`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ note: "Repeated abuse" }),
  });
  assert.equal(response.status, 200);
  assert.equal(currentReport.status, "resolved");
  assert.equal(seen.sessionsRevoked, true);
  assert.equal(seen.action.action, "owner_suspended");
  assert.equal((await response.json()).affectedReports, 1);
});

test("only administrators can list users and private photo data is omitted", async () => {
  const denied = await fetch(`${baseUrl}/api/moderation/users`, { headers: { "x-test-role": "moderator" } });
  assert.equal(denied.status, 403);

  currentUser = makeUser({ role: "moderator" });
  const response = await fetch(`${baseUrl}/api/moderation/users?q=Member&field=name`);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.users[0].role, "moderator");
  assert.equal(data.users[0].image, undefined);
});

test("protects administrators from changing their own role", async () => {
  const response = await fetch(`${baseUrl}/api/moderation/users/admin-user/role`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role: "user" }),
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).message, /Another administrator/);
});

test("stores role changes atomically and revokes active sessions", async () => {
  const response = await fetch(`${baseUrl}/api/moderation/users/member-1/role`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role: "moderator" }),
  });
  assert.equal(response.status, 200);
  assert.equal(currentUser.role, "moderator");
  assert.equal(seen.sessionsRevoked, true);
  assert.equal(seen.action.action, "role_changed");
  assert.equal(seen.action.previousRole, "user");
});

test("reactivates suspended users and records the action", async () => {
  currentUser = makeUser({ banned: true, banReason: "Spam" });
  const response = await fetch(`${baseUrl}/api/moderation/users/member-1/reactivate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ note: "Appeal accepted" }),
  });
  assert.equal(response.status, 200);
  assert.equal(currentUser.banned, false);
  assert.equal(seen.action.action, "user_reactivated");
  assert.equal(seen.action.note, "Appeal accepted");
});
