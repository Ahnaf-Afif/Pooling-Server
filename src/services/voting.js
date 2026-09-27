import { withDatabaseTransaction } from "../db.js";
import Poll from "../models/Poll.js";
import VoteReceipt from "../models/VoteReceipt.js";

export class VoteError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

async function replayVote(pollSlug, voterKey, optionId, session = null) {
  const receipt = await VoteReceipt.findOne({ pollSlug, voterKey }).session(session).lean();
  if (!receipt) return null;
  const poll = await Poll.findOne({ slug: pollSlug, deletedAt: null }).session(session);
  if (!poll) throw new VoteError("Poll not found", 404);
  if (String(receipt.optionId) !== optionId) throw new VoteError("You have already voted in this poll", 409);
  // An identical retry is successful even if voting closed after it committed.
  return { poll, replayed: true };
}

export async function recordVote({ pollSlug, voterKey, optionId }) {
  try {
    return await withDatabaseTransaction(async (session) => {
      const existing = await replayVote(pollSlug, voterKey, optionId, session);
      if (existing) return existing;
      await VoteReceipt.create([{ pollSlug, voterKey, optionId }], { session });
      const poll = await Poll.findOneAndUpdate(
        { slug: pollSlug, "options._id": optionId, deletedAt: null, status: { $in: ["active", null] } },
        { $inc: { "options.$.votes": 1, totalVotes: 1 }, $set: { lastVotedAt: new Date() } },
        { returnDocument: "after", runValidators: true, session },
      );
      if (poll) return { poll, replayed: false };
      const exists = await Poll.exists({ slug: pollSlug, deletedAt: null }).session(session);
      throw new VoteError(exists ? "This poll is closed or the option no longer exists" : "Poll not found", exists ? 409 : 404);
    });
  } catch (error) {
    // Two simultaneous requests may race on the unique receipt index. Read
    // the committed winner outside the aborted transaction, without recounting.
    if (error.code === 11000) {
      const existing = await replayVote(pollSlug, voterKey, optionId);
      if (existing) return existing;
    }
    throw error;
  }
}
