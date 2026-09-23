import assert from "node:assert/strict";
import test from "node:test";

import Poll from "../src/models/Poll.js";

const basePoll = {
  slug: "example-poll-a1",
  question: "Which option do you prefer?",
  category: "Tech",
  options: [{ label: "One" }, { label: "Two" }],
};

test("marks only recently active polls with meaningful participation as trending", () => {
  const recent = new Poll({ ...basePoll, totalVotes: 3, lastVotedAt: new Date() });
  const quiet = new Poll({ ...basePoll, slug: "quiet-poll-a1", totalVotes: 2, lastVotedAt: new Date() });
  const stale = new Poll({ ...basePoll, slug: "stale-poll-a1", totalVotes: 100, lastVotedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) });

  assert.equal(recent.trending, true);
  assert.equal(quiet.trending, false);
  assert.equal(stale.trending, false);
});

test("uses creation time for polls created before activity tracking was added", () => {
  const legacyRecent = new Poll({ ...basePoll, totalVotes: 3, createdAt: new Date() });
  const legacyOld = new Poll({ ...basePoll, slug: "old-legacy-poll-a1", totalVotes: 20, createdAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) });

  assert.equal(legacyRecent.trending, true);
  assert.equal(legacyOld.trending, false);
});

test("does not expose the private owner identifier", () => {
  const poll = new Poll({ ...basePoll, creatorId: "private-user-id" });
  assert.equal(poll.toJSON().creatorId, undefined);
  assert.equal(poll.status, "active");
});
