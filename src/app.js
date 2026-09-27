import cors from "cors";
import { randomUUID } from "node:crypto";
import express from "express";
import helmet from "helmet";
import mongoose from "mongoose";
import { toNodeHandler } from "better-auth/node";

import { auth, getAuthConfiguration } from "./auth.js";
import { cleanupAuthRateLimitRecords } from "./auth-maintenance.js";
import { getClientOrigins } from "./config.js";
import { connectDatabase, getMongoDatabase } from "./db.js";
import moderationRoutes from "./routes/moderation.js";
import accountRoutes from "./routes/account.js";
import securityRoutes from "./routes/security.js";
import pollRoutes from "./routes/polls.js";
import { IdentityError } from "./services/identity-transaction.js";
import { limitReads, limitWriteNetwork } from "./rate-limit.js";

export function createApp(clientOrigins = getClientOrigins()) {
  const app = express();

  app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.use((request, response, next) => {
    const supplied = request.get("x-request-id");
    request.id = supplied && /^[A-Za-z0-9._:-]{1,100}$/.test(supplied) ? supplied : randomUUID();
    response.set("X-Request-ID", request.id);
    next();
  });
  app.use(helmet());
  app.use(
    cors({
      origin(origin, callback) {
        if (!origin || clientOrigins.includes(origin)) return callback(null, true);
        return callback(new Error("Origin is not allowed"));
      },
      credentials: true,
      methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    }),
  );

  app.get("/", (_, response) => {
    response.json({ service: "What Do You Think API", health: "/api/health" });
  });

  app.get("/api/health/live", (request, response) => {
    response.json({ status: "ok", requestId: request.id });
  });

  app.use("/api", async (request, response, next) => {
    try {
      await connectDatabase();
      await cleanupAuthRateLimitRecords().catch((error) => {
        console.error(JSON.stringify({ level: "warn", event: "auth_rate_limit_cleanup_failed", requestId: request.id, error: error.message }));
      });
      next();
    } catch (error) {
      console.error(JSON.stringify({ level: "error", event: "database_connect_failed", requestId: request.id, error: error.message }));
      response.status(503).json({ message: "Database unavailable", requestId: request.id });
    }
  });

  app.use("/api", limitReads, limitWriteNetwork);
  app.all("/api/auth/*splat", toNodeHandler(auth));
  app.use(express.json({ limit: "10kb" }));

  app.get("/api/health", async (request, response, next) => {
    const ready = mongoose.connection.readyState === 1;
    if (!ready) return response.status(503).json({ status: "unavailable", requestId: request.id });
    try {
      await getMongoDatabase().command({ ping: 1 });
      return response.json({ status: "ok", requestId: request.id });
    } catch (error) {
      return next(error);
    }
  });
  app.get("/api/auth-config", (_, response) => {
    response.json(getAuthConfiguration());
  });
  app.use("/api/account/security", securityRoutes);
  app.use("/api/account", accountRoutes);
  app.use("/api/polls", pollRoutes);
  app.use("/api/moderation", moderationRoutes);

  app.use((_, response) => response.status(404).json({ message: "Route not found" }));
  app.use((error, request, response, _next) => {
    const isBadRequest = error.name === "ValidationError" || error.type === "entity.parse.failed";
    const isPayloadTooLarge = error.type === "entity.too.large";
    const status = error instanceof IdentityError ? error.status : isPayloadTooLarge ? 413 : isBadRequest ? 400 : error.message === "Origin is not allowed" ? 403 : 500;
    if (status === 500) {
      console.error(JSON.stringify({ level: "error", event: "request_failed", requestId: request.id, error: error.message, stack: error.stack }));
    }
    response.status(status).json({
      message: isPayloadTooLarge ? "The request body is too large" : isBadRequest ? "The request data is invalid" : status === 500 ? "Something went wrong" : error.message,
      requestId: request.id,
      ...(error instanceof IdentityError && error.code ? { code: error.code } : {}),
    });
  });

  return app;
}

export default createApp();
