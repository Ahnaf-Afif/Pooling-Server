import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { startServer, stopServer } from "./helpers/http.js";
import express from "express";
import mongoose from "mongoose";

import { closeDatabases } from "../src/db.js";
import Poll from "../src/models/Poll.js";
import RateBucket from "../src/models/RateBucket.js";
import VoteReceipt from "../src/models/VoteReceipt.js";
import pollRoutes from "../src/routes/polls.js";

const originalPollMethods = {
  find: Poll.find,
  aggregate: Poll.aggregate,
  distinct: Poll.distinct,
  countDocuments: Poll.countDocuments,
  create: Poll.create,
  exists: Poll.exists,
  findOneAndUpdate: Poll.findOneAndUpdate,
};
const originalTransaction = mongoose.connection.transaction;
const originalRateLimit = RateBucket.findOneAndUpdate;
const originalVoteReceiptMethods = {
  create: VoteReceipt.create,
  deleteOne: VoteReceipt.deleteOne,
};
const seen = {};
let server;
let baseUrl;

before(async () => {
  Poll.find = (filter) => {
    seen.filter = filter;
    return {
      sort(value) { seen.sort = value; return this; },
      skip(value) { seen.skip = value; return this; },
      limit(value) {
        seen.limit = value;
        return Promise.resolve([{ slug: "one" }, { slug: "two" }, { slug: "three" }]);
      },
    };
  };
  Poll.aggregate = async () => [{ activePolls: 5, totalVotes: 23 }];
  Poll.distinct = async () => ["Tech", "Social"];
  Poll.countDocuments = async () => 2;
  Poll.create = async (data) => {
    seen.createdPoll = data;
    return { id: data.slug, ...data };
  };
  Poll.findOneAndUpdate = async (filter, update) => {
    seen.voteFilter = filter;
    seen.voteUpdate = update;
    return { slug: filter.slug };
  };
  RateBucket.findOneAndUpdate = async () => ({ count: 1 });
  mongoose.connection.transaction = async (work) => work({ testSession: true });
  VoteReceipt.create = async (data) => [{ _id: "receipt-id", ...data[0] }];
  VoteReceipt.deleteOne = async () => ({ deletedCount: 1 });

  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => {
    const authState = request.headers["x-test-auth"];
    request.auth = authState === "none"
      ? { user: null }
      : { user: { id: "test-user", emailVerified: authState !== "unverified" } };
    next();
  });
  app.use("/api/polls", pollRoutes);
  server = await startServer(app);
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await stopServer(server);
  Object.assign(Poll, originalPollMethods);
  mongoose.connection.transaction = originalTransaction;
  RateBucket.findOneAndUpdate = originalRateLimit;
  Object.assign(VoteReceipt, originalVoteReceiptMethods);
  await closeDatabases();
});

test("filters and paginates the poll feed", async () => {
  const response = await fetch(`${baseUrl}/api/polls?category=Tech&trending=true&limit=2&page=2`);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(seen.filter.category, "Tech");
  assert.deepEqual(seen.filter.totalVotes, { $gte: 3 });
  assert.ok(seen.filter.$or[0].lastVotedAt.$gte instanceof Date);
  assert.ok(seen.filter.$or[1].createdAt.$gte instanceof Date);
  assert.deepEqual(seen.sort, { totalVotes: -1, lastVotedAt: -1, createdAt: -1 });
  assert.equal(seen.skip, 2);
  assert.equal(seen.limit, 3);
  assert.equal(data.polls.length, 2);
  assert.equal(data.hasMore, true);
  assert.equal(data.stats.activePolls, 5);
});

test("loads a validated set of polls in one request", async () => {
  const response = await fetch(`${baseUrl}/api/polls?ids=first-poll-a1,second-poll-b2&limit=50`);
  assert.equal(response.status, 200);
  assert.deepEqual(seen.filter.slug, { $in: ["first-poll-a1", "second-poll-b2"] });

  const invalid = await fetch(`${baseUrl}/api/polls?ids=not%20a%20slug`);
  assert.equal(invalid.status, 400);
});

test("records recent activity whenever a vote is accepted", async () => {
  const optionId = "507f1f77bcf86cd799439011";
  const response = await fetch(`${baseUrl}/api/polls/example-poll/votes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ optionId }),
  });
  assert.equal(response.status, 200);
  assert.equal(seen.voteFilter.slug, "example-poll");
  assert.equal(seen.voteFilter["options._id"], optionId);
  assert.deepEqual(seen.voteFilter.status, { $in: ["active", null] });
  assert.equal(seen.voteFilter.deletedAt, null);
  assert.ok(seen.voteUpdate.$set.lastVotedAt instanceof Date);
});

test("rejects an invalid page", async () => {
  const response = await fetch(`${baseUrl}/api/polls?page=0`);
  assert.equal(response.status, 400);
  const excessive = await fetch(`${baseUrl}/api/polls?page=1001`);
  assert.equal(excessive.status, 400);
});

test("rejects empty create and vote bodies instead of returning server errors", async () => {
  for (const path of ["/api/polls", "/api/polls/example/votes"]) {
    const response = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    assert.equal(response.status, 400);
  }
});

test("requires authentication before creating a poll", async () => {
  const response = await fetch(`${baseUrl}/api/polls`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-test-auth": "none" },
    body: JSON.stringify({ question: "A valid question?", category: "Tech", options: ["One", "Two"] }),
  });
  assert.equal(response.status, 401);
});

test("requires a verified email before creating a poll", async () => {
  const response = await fetch(`${baseUrl}/api/polls`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-test-auth": "unverified" },
    body: JSON.stringify({ question: "A valid question?", category: "Tech", options: ["One", "Two"] }),
  });
  assert.equal(response.status, 403);
});

test("assigns a newly created poll to the signed-in account", async () => {
  const response = await fetch(`${baseUrl}/api/polls`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question: "A valid question?", category: "Tech", options: ["One", "Two"] }),
  });
  assert.equal(response.status, 201);
  assert.equal(seen.createdPoll.creatorId, "test-user");
  assert.deepEqual(seen.createdPoll.options, [{ label: "One" }, { label: "Two" }]);
});

test("scopes poll management actions to the signed-in owner", async () => {
  const response = await fetch(`${baseUrl}/api/polls/example-poll/close`, { method: "POST" });
  assert.equal(response.status, 200);
  assert.equal(seen.voteFilter.slug, "example-poll");
  assert.equal(seen.voteFilter.creatorId, "test-user");
  assert.equal(seen.voteFilter.deletedAt, null);
});
