import mongoose from "mongoose";

// At most one current request per account. Decisions remain in the audit log.
const schema = new mongoose.Schema({
  _id: { type: String, required: true },
  requestId: { type: String, required: true, unique: true },
  status: { type: String, enum: ["pending", "approved"], required: true },
  factorFingerprint: { type: String, required: true, select: false },
  createdAt: { type: Date, required: true },
  expiresAt: { type: Date, required: true },
  approvedAt: { type: Date, default: null },
  approvedBy: { type: String, default: null },
}, { versionKey: false });

schema.index({ status: 1, _id: 1 });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.model("RecoveryRequest", schema);
