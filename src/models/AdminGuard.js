import mongoose from "mongoose";

const schema = new mongoose.Schema({ _id: String, revision: Number }, { versionKey: false });

export default mongoose.model("AdminGuard", schema);
