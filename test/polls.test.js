import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import express from "express";

import Poll from "../src/models/Poll.js";
import RateBucket from "../src/models/RateBucket.js";
import VoteReceipt from "../src/models/VoteReceipt.js";
import pollRoutes from "../src/routes/polls.js";

const originalPollMethods = {
  find: Poll.find,
  aggregate: Poll.aggregate,
  distinct: Poll.distinct,
  countDocuments: Poll.countDocuments,
  findOneAndUpdate: Poll.findOneAndUpdate,
};
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
  Poll.findOneAndUpdate = async (filter, update) => {
    seen.voteFilter = filter;
    seen.voteUpdate = update;
    return { slug: filter.slug };
  };
  RateBucket.findOneAndUpdate = async () => ({ count: 1 });
  VoteReceipt.create = async (data) => ({ _id: "receipt-id", ...data });
  VoteReceipt.deleteOne = async () => ({ deletedCount: 1 });

  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => {
    request.auth = request.headers["x-test-auth"] === "none"
      ? { user: null }
      : { user: { id: "test-user", emailVerified: true } };
    next();
  });
  app.use("/api/polls", pollRoutes);
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  Object.assign(Poll, originalPollMethods);
  RateBucket.findOneAndUpdate = originalRateLimit;
  Object.assign(VoteReceipt, originalVoteReceiptMethods);
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

test("loads a validated set of browser-owned polls in one request", async () => {
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
