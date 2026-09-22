import "dotenv/config";
import mongoose from "mongoose";

import app from "./app.js";
import { getConfig } from "./config.js";
import { connectDatabase } from "./db.js";

const config = getConfig();
await connectDatabase();

const server = app.listen(config.port, () => {
  console.log(`API listening on port ${config.port}`);
});
server.requestTimeout = 15_000;
server.headersTimeout = 16_000;
server.keepAliveTimeout = 5_000;

async function shutdown(signal) {
  console.log(`${signal} received, shutting down`);
  const forceExit = setTimeout(() => process.exit(1), 10_000);
  forceExit.unref();
  server.close(async () => {
    await mongoose.disconnect();
    clearTimeout(forceExit);
    process.exit(0);
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
