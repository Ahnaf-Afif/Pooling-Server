import mongoose from "mongoose";
import { CATEGORIES, TRENDING_MIN_VOTES, TRENDING_WINDOW_MS } from "../constants.js";

const optionSchema = new mongoose.Schema(
  {
    label: { type: String, required: true, trim: true, maxlength: 100 },
    votes: { type: Number, default: 0, min: 0 },
  },
  { versionKey: false, toJSON: { virtuals: true } },
);

const pollSchema = new mongoose.Schema(
  {
    slug: { type: String, required: true, unique: true, index: true },
    question: { type: String, required: true, trim: true, maxlength: 240 },
    category: { type: String, required: true, enum: CATEGORIES, index: true },
    options: {
      type: [optionSchema],
      validate: {
        validator: (options) => options.length >= 2 && options.length <= 6,
        message: "A poll must have between 2 and 6 options",
      },
    },
    totalVotes: { type: Number, default: 0, min: 0, index: true },
    lastVotedAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    versionKey: false,
    id: false,
    toJSON: {
      virtuals: true,
      transform: (_, value) => {
        delete value._id;
        return value;
      },
    },
  },
);

pollSchema.virtual("id").get(function getId() {
  return this.slug;
});

pollSchema.virtual("trending").get(function isTrending() {
  const latestActivity = this.lastVotedAt || this.createdAt;
  return this.totalVotes >= TRENDING_MIN_VOTES &&
    latestActivity instanceof Date &&
    latestActivity.getTime() >= Date.now() - TRENDING_WINDOW_MS;
});

pollSchema.index({ createdAt: -1 });
pollSchema.index({ lastVotedAt: -1, totalVotes: -1 });

export default mongoose.model("Poll", pollSchema);
