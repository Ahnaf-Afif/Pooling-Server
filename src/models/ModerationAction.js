import mongoose from "mongoose";

const moderationActionSchema = new mongoose.Schema(
  {
    action: {
      type: String,
      required: true,
      enum: [
        "note_added",
        "report_dismissed",
        "report_reopened",
        "poll_edited",
        "poll_removed",
        "owner_suspended",
        "user_suspended",
        "user_reactivated",
        "role_changed",
      ],
      index: true,
    },
    actorId: { type: String, required: true, index: true },
    actorName: { type: String, required: true, trim: true, maxlength: 160 },
    actorRole: { type: String, required: true, enum: ["moderator", "admin"] },
    reportId: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },
    pollSlug: { type: String, default: null, index: true },
    targetUserId: { type: String, default: null, index: true },
    note: { type: String, trim: true, maxlength: 500, default: "" },
    changedFields: [{ type: String, trim: true }],
    previousRole: { type: String, default: null },
    newRole: { type: String, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);

moderationActionSchema.index({ reportId: 1, createdAt: 1 });
moderationActionSchema.index({ targetUserId: 1, createdAt: -1 });

export default mongoose.model("ModerationAction", moderationActionSchema);
