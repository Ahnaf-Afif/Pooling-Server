import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import express from "express";
import mongoose from "mongoose";

import { auth } from "../src/auth.js";
import { closeDatabases } from "../src/db.js";
import ModerationAction from "../src/models/ModerationAction.js";
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
  pollFind: Poll.find,
  pollFindOne: Poll.findOne,
  pollFindOneAndUpdate: Poll.findOneAndUpdate,
  actionFind: ModerationAction.find,
  actionCreate: ModerationAction.create,
  rateLimit: RateBucket.findOneAndUpdate,
  listUsers: auth.api.listUsers,
  getUser: auth.api.getUser,
  setRole: auth.api.setRole,
  banUser: auth.api.banUser,
  unbanUser: auth.api.unbanUser,
};
const seen = {};
let currentReport;
let server;
let baseUrl;

function queryResult(value) {
  return {
    sort() { return this; },
    limit() { return this; },
    lean() { return Promise.resolve(value); },
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
    async save() { return this; },
  };
}

function makePoll() {
  return {
    _id: pollId,
    slug: "reported-poll",
    question: "Which tool do you use?",
    category: "Tech",
    creatorId: "poll-owner",
    totalVotes: 7,
    status: "active",
    deletedAt: null,
    options: [
      { _id: optionIds[0], label: "One", votes: 3 },
      { _id: optionIds[1], label: "Two", votes: 4 },
    ],
  };
}

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => {
    const role = request.headers["x-test-role"] || "admin";
    request.auth = {
      user: {
        id: "admin-user",
        name: "Test Admin",
        email: "admin@example.com",
        role,
      },
    };
    next();
  });
  app.use("/api/moderation", moderationRoutes);
  app.use((error, _request, response, _next) => response.status(500).json({ message: error.message }));
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(() => {
  for (const key of Object.keys(seen)) delete seen[key];
  currentReport = makeReport();
  Report.find = () => queryResult([{
    ...currentReport,
    createdAt: new Date("2026-01-01T00:00:00Z"),
  }]);
  Report.findById = async () => currentReport;
  Poll.find = () => ({ lean: async () => [makePoll()] });
  Poll.findOne = async () => makePoll();
  Poll.findOneAndUpdate = async (filter, update) => {
    seen.pollFilter = filter;
    seen.pollUpdate = update;
    return makePoll();
  };
  ModerationAction.find = () => queryResult([]);
  ModerationAction.create = async (data) => {
    seen.action = data;
    return { _id: new mongoose.Types.ObjectId(), createdAt: new Date(), ...data };
  };
  RateBucket.findOneAndUpdate = async () => ({ count: 1 });
  auth.api.listUsers = async (options) => {
    seen.listUsers = options;
    return {
      users: [{
        id: "member-1",
        name: "Member One",
        email: "member@example.com",
        image: "https://example.com/private-photo.jpg",
        emailVerified: true,
        role: "moderator",
        banned: false,
        createdAt: new Date("2026-01-02T00:00:00Z"),
      }],
      total: 1,
    };
  };
  auth.api.getUser = async () => ({
    id: "member-1",
    name: "Member One",
    email: "member@example.com",
    emailVerified: true,
    role: "user",
    banned: false,
    createdAt: new Date(),
  });
  auth.api.setRole = async ({ body }) => {
    seen.setRole = body;
    return { user: { ...(await auth.api.getUser()), role: body.role } };
  };
  auth.api.banUser = async ({ body }) => {
    seen.banUser = body;
    return { user: { ...(await auth.api.getUser()), id: body.userId, banned: true, banReason: body.banReason } };
  };
  auth.api.unbanUser = async ({ body }) => {
    seen.unbanUser = body;
    return { user: { ...(await auth.api.getUser()), id: body.userId, banned: false } };
  };
});

after(async () => {
  await new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  });
  Report.find = original.reportFind;
  Report.findById = original.reportFindById;
  Poll.find = original.pollFind;
  Poll.findOne = original.pollFindOne;
  Poll.findOneAndUpdate = original.pollFindOneAndUpdate;
  ModerationAction.find = original.actionFind;
  ModerationAction.create = original.actionCreate;
  RateBucket.findOneAndUpdate = original.rateLimit;
  auth.api.listUsers = original.listUsers;
  auth.api.getUser = original.getUser;
  auth.api.setRole = original.setRole;
  auth.api.banUser = original.banUser;
  auth.api.unbanUser = original.unbanUser;
  await closeDatabases();
});

test("keeps reporter identity private in the moderation queue", async () => {
  const response = await fetch(`${baseUrl}/api/moderation/reports`);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.reports[0].reporterKey, undefined);
  assert.equal(data.reports[0].reporterUserId, undefined);
  assert.equal(data.reports[0].poll.options[0].votes, 3);
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

test("moderator edits preserve existing vote data and resolve the report", async () => {
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
  assert.equal(response.status, 200);
  assert.equal(currentReport.status, "resolved");
  assert.equal(String(seen.pollUpdate.$set.options[0]._id), String(optionIds[0]));
  assert.equal(seen.pollUpdate.$set.options[0].votes, 3);
  assert.equal(seen.pollUpdate.$set.options[1].votes, 4);
  assert.equal(seen.action.action, "poll_edited");
  assert.deepEqual(seen.action.changedFields, ["question", "answer options"]);
});

test("removing a reported poll also resolves the report and records the decision", async () => {
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
});

test("adds internal notes to a report audit history", async () => {
  const response = await fetch(`${baseUrl}/api/moderation/reports/${reportId}/notes`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-test-role": "moderator" },
    body: JSON.stringify({ note: "Waiting for a second review" }),
  });
  assert.equal(response.status, 201);
  assert.equal(seen.action.action, "note_added");
  assert.equal(seen.action.note, "Waiting for a second review");
});

test("only administrators can list users and private photo data is omitted", async () => {
  const denied = await fetch(`${baseUrl}/api/moderation/users`, { headers: { "x-test-role": "moderator" } });
  assert.equal(denied.status, 403);

  const response = await fetch(`${baseUrl}/api/moderation/users?q=Member&field=name`);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.users[0].role, "moderator");
  assert.equal(data.users[0].image, undefined);
  assert.equal(seen.listUsers.query.searchField, "name");
  assert.equal(seen.listUsers.query.searchValue, "Member");
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

test("stores managed roles through Better Auth and audits the change", async () => {
  const response = await fetch(`${baseUrl}/api/moderation/users/member-1/role`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role: "moderator" }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(seen.setRole, { userId: "member-1", role: "moderator" });
  assert.equal(seen.action.action, "role_changed");
  assert.equal(seen.action.previousRole, "user");
  assert.equal(seen.action.newRole, "moderator");
});

test("reactivates suspended users and records the action", async () => {
  const response = await fetch(`${baseUrl}/api/moderation/users/member-1/reactivate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ note: "Appeal accepted" }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(seen.unbanUser, { userId: "member-1" });
  assert.equal(seen.action.action, "user_reactivated");
  assert.equal(seen.action.note, "Appeal accepted");
});
