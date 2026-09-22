import cors from "cors";
import express from "express";
import helmet from "helmet";
import mongoose from "mongoose";

import { getClientOrigins } from "./config.js";
import { connectDatabase } from "./db.js";
import pollRoutes from "./routes/polls.js";

export function createApp(clientOrigins = getClientOrigins()) {
  const app = express();

  app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.use(helmet());
  app.use(
    cors({
      origin(origin, callback) {
        if (!origin || clientOrigins.includes(origin)) return callback(null, true);
        return callback(new Error("Origin is not allowed"));
      },
    }),
  );
  app.use(express.json({ limit: "10kb" }));

  app.get("/", (_, response) => {
    response.json({ service: "What Do You Think API", health: "/api/health" });
  });

  app.use("/api", async (_request, response, next) => {
    try {
      await connectDatabase();
      next();
    } catch (error) {
      console.error("Database connection failed:", error);
      response.status(503).json({ message: "Database unavailable" });
    }
  });

  app.get("/api/health", (_, response) => {
    const ready = mongoose.connection.readyState === 1;
    response.status(ready ? 200 : 503).json({ status: ready ? "ok" : "unavailable" });
  });
  app.use("/api/polls", pollRoutes);

  app.use((_, response) => response.status(404).json({ message: "Route not found" }));
  app.use((error, _request, response, _next) => {
    const isBadRequest = error.name === "ValidationError" || error.type === "entity.parse.failed";
    const status = isBadRequest ? 400 : error.message === "Origin is not allowed" ? 403 : 500;
    if (status === 500) console.error(error);
    response.status(status).json({
      message: isBadRequest ? "The request data is invalid" : status === 500 ? "Something went wrong" : error.message,
    });
  });

  return app;
}

export default createApp();
