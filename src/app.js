import cors from "cors";
import express from "express";
import helmet from "helmet";
import mongoose from "mongoose";

import pollRoutes from "./routes/polls.js";

export function createApp(clientOrigins = ["http://localhost:3000"]) {
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
