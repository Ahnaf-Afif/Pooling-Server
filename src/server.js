import "dotenv/config";
import mongoose from "mongoose";

import { createApp } from "./app.js";
import { getConfig } from "./config.js";

const config = getConfig();

await mongoose.connect(config.mongoUri, {
  serverSelectionTimeoutMS: 10000,
  maxPoolSize: 10,
});

const server = createApp(config.clientOrigins).listen(config.port, () => {
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
