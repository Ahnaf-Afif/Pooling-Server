import mongoose from "mongoose";

const voteReceiptSchema = new mongoose.Schema(
  {
    pollSlug: { type: String, required: true, index: true },
    voterKey: { type: String, required: true },
    optionId: { type: mongoose.Schema.Types.ObjectId, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);

voteReceiptSchema.index({ pollSlug: 1, voterKey: 1 }, { unique: true });
voteReceiptSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 365 * 2 });

export default mongoose.model("VoteReceipt", voteReceiptSchema);
