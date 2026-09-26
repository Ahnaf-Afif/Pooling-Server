import mongoose from "mongoose";

const authSessionSchema = new mongoose.Schema(
  { _id: mongoose.Schema.Types.Mixed },
  { collection: "session", strict: false, versionKey: false },
);

export default mongoose.model("AuthSession", authSessionSchema);
