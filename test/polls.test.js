import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import express from "express";

import Poll from "../src/models/Poll.js";
import pollRoutes from "../src/routes/polls.js";

const original = {
  find: Poll.find,
  aggregate: Poll.aggregate,
  distinct: Poll.distinct,
  countDocuments: Poll.countDocuments,
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

  const app = express();
  app.use("/api/polls", pollRoutes);
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  Object.assign(Poll, original);
});

test("filters and paginates the poll feed", async () => {
  const response = await fetch(`${baseUrl}/api/polls?category=Tech&trending=true&limit=2&page=2`);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.deepEqual(seen.filter, { category: "Tech", totalVotes: { $gte: 10 } });
  assert.deepEqual(seen.sort, { totalVotes: -1, createdAt: -1 });
  assert.equal(seen.skip, 2);
  assert.equal(seen.limit, 3);
  assert.equal(data.polls.length, 2);
  assert.equal(data.hasMore, true);
  assert.equal(data.stats.activePolls, 5);
});

test("rejects an invalid page", async () => {
  const response = await fetch(`${baseUrl}/api/polls?page=0`);
  assert.equal(response.status, 400);
});
