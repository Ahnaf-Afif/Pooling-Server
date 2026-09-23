import mongoose from "mongoose";

const reportSchema = new mongoose.Schema(
  {
    pollSlug: { type: String, required: true, index: true },
    reporterKey: { type: String, required: true },
    reporterUserId: { type: String, default: null },
    reason: {
      type: String,
      required: true,
      enum: ["spam", "harassment", "hate", "misinformation", "other"],
    },
    details: { type: String, trim: true, maxlength: 500, default: "" },
    status: {
      type: String,
      enum: ["pending", "resolved", "dismissed"],
      default: "pending",
      index: true,
    },
    reviewedBy: { type: String, default: null },
    reviewedAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false },
);

reportSchema.index({ pollSlug: 1, reporterKey: 1 }, { unique: true });
reportSchema.index({ status: 1, createdAt: -1 });

export default mongoose.model("Report", reportSchema);
