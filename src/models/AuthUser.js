import mongoose from "mongoose";

const authUserSchema = new mongoose.Schema(
  { _id: mongoose.Schema.Types.Mixed },
  { collection: "user", strict: false, versionKey: false },
);

export default mongoose.model("AuthUser", authUserSchema);
