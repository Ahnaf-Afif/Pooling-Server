import mongoose from "mongoose";

const commandReceiptSchema = new mongoose.Schema({
  _id: String,
  actorId: { type: String, required: true, index: true },
  operation: { type: String, required: true },
  requestHash: { type: String, required: true, select: false },
  result: { type: mongoose.Schema.Types.Mixed, default: null },
  expiresAt: { type: Date, required: true },
}, { timestamps: { createdAt: true, updatedAt: false }, versionKey: false });

commandReceiptSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
commandReceiptSchema.index({ "result.userId": 1 });

export default mongoose.model("CommandReceipt", commandReceiptSchema);
