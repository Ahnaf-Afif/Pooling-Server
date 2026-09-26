import mongoose from "mongoose";

// One shared cache document; keep stale values while a refresh is in flight.
const schema = new mongoose.Schema({
  _id: String,
  stats: { type: mongoose.Schema.Types.Mixed, default: null },
  expiresAt: Date,
  refreshUntil: Date,
  refreshToken: String,
}, { versionKey: false });

export default mongoose.model("PlatformStats", schema);
