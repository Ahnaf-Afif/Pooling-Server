import mongoose from "mongoose";

const rateBucketSchema = new mongoose.Schema({
  _id: String,
  count: Number,
  expiresAt: { type: Date, required: true },
});

rateBucketSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.model("RateBucket", rateBucketSchema);
