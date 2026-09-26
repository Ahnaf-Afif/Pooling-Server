import { createHash } from "node:crypto";
import { Router } from "express";
import { fromNodeHeaders } from "better-auth/node";

import { auth } from "../auth.js";
import { requireRecentAuth, requireVerifiedUser } from "../auth-middleware.js";
import AuthSession from "../models/AuthSession.js";
import RateBucket from "../models/RateBucket.js";
import { limitSecurityAttempts, limitWrites } from "../rate-limit.js";
import { hasRecentVerification, isRecent, isStaff, STAFF_SESSION_MS } from "../security-policy.js";
import { idCandidates } from "../services/user-admin.js";

const router = Router();
router.use((_request, response, next) => { response.set("Cache-Control", "private, no-store"); next(); });
router.use(requireVerifiedUser);

function sendError(error, response, next) {
  if (error.statusCode >= 400 && error.statusCode < 500) {
    return response.status(error.statusCode).json({ message: error.body?.message || "Security verification failed" });
  }
  return next(error);
}

function forwardCookies(headers, response) {
  const cookies = headers.getSetCookie();
  for (const cookie of cookies) response.append("Set-Cookie", cookie);
  const sessionCookie = cookies.find((cookie) => /^(?:__Secure-)?better-auth\.session_token=/.test(cookie));
  if (!sessionCookie) return null;
  const value = decodeURIComponent(sessionCookie.split(";", 1)[0].split("=").slice(1).join("="));
  return value.slice(0, value.lastIndexOf("."));
}

router.get("/", (request, response) => {
  response.json({
    enabled: Boolean(request.auth.user.twoFactorEnabled),
    staff: isStaff(request.auth.user),
    verified: hasRecentVerification(request.auth),
    staffSessionExpired: !isRecent(request.auth.session.createdAt, STAFF_SESSION_MS),
  });
});

router.post("/enable", requireRecentAuth, limitSecurityAttempts, async (request, response, next) => {
  try {
    const result = await auth.api.enableTwoFactor({ body: { method: "totp" }, headers: fromNodeHeaders(request.headers), returnHeaders: true });
    forwardCookies(result.headers, response);
    return response.json(result.response);
  } catch (error) { return sendError(error, response, next); }
});

router.post("/verify", limitSecurityAttempts, async (request, response, next) => {
  const code = typeof request.body?.code === "string" ? request.body.code.trim() : "";
  const backup = request.body?.backup === true;
  if ((!backup && !/^\d{6}$/.test(code)) || (backup && (!request.auth.user.twoFactorEnabled || !/^[a-zA-Z0-9-]{8,40}$/.test(code)))) {
    return response.status(400).json({ message: "Enter a valid authenticator or recovery code" });
  }
  try {
    // Claim each TOTP once across all sessions. Failed attempts are bounded by
    // the account-wide limiter; old claims expire with the rate-bucket TTL.
    if (!backup) {
      const digest = createHash("sha256").update(`${request.auth.user.id}:${code}`).digest("hex");
      try {
        await RateBucket.create({ _id: `totp:${digest}`, count: 1, expiresAt: new Date(Date.now() + 120_000) });
      } catch (error) {
        if (error.code === 11000) return response.status(409).json({ message: "Wait for a new authenticator code before trying again" });
        throw error;
      }
    }
    const method = backup ? auth.api.verifyBackupCode : auth.api.verifyTOTP;
    const result = await method({ body: { code, trustDevice: false }, headers: fromNodeHeaders(request.headers), returnHeaders: true });
    const token = forwardCookies(result.headers, response) || request.auth.session.token;
    const updated = await AuthSession.updateOne({ token }, { $set: { mfaVerifiedAt: new Date() } });
    if (!updated.matchedCount) return response.status(401).json({ message: "Sign in again to finish verification" });
    return response.json({ message: "Security verification complete" });
  } catch (error) { return sendError(error, response, next); }
});

router.post("/disable", requireRecentAuth, limitSecurityAttempts, async (request, response, next) => {
  if (isStaff(request.auth.user)) return response.status(403).json({ message: "Staff accounts must keep two-factor authentication enabled" });
  try {
    const result = await auth.api.disableTwoFactor({ body: {}, headers: fromNodeHeaders(request.headers), returnHeaders: true });
    const token = forwardCookies(result.headers, response);
    await AuthSession.deleteMany({ userId: { $in: idCandidates(request.auth.user.id) }, token: { $ne: token } });
    return response.json({ message: "Two-factor authentication disabled; other sessions signed out" });
  } catch (error) { return sendError(error, response, next); }
});

router.get("/sessions", async (request, response, next) => {
  try {
    const sessions = await AuthSession.find({ userId: { $in: idCandidates(request.auth.user.id) }, expiresAt: { $gt: new Date() } })
      .select("_id createdAt updatedAt expiresAt userAgent token").sort({ createdAt: -1 }).lean();
    return response.json({ sessions: sessions.map((session) => ({
      id: String(session._id), current: session.token === request.auth.session.token,
      createdAt: session.createdAt, updatedAt: session.updatedAt,
      expiresAt: session.expiresAt, device: session.userAgent || "Unknown browser",
    })) });
  } catch (error) { return next(error); }
});

router.post("/sessions/revoke", requireRecentAuth, limitWrites, async (request, response, next) => {
  if (request.body?.others !== true && (typeof request.body?.id !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(request.body.id))) {
    return response.status(400).json({ message: "Choose a session to sign out" });
  }
  try {
    const filter = { userId: { $in: idCandidates(request.auth.user.id) }, token: { $ne: request.auth.session.token } };
    if (request.body.others !== true) filter._id = { $in: idCandidates(request.body.id) };
    await AuthSession.deleteMany(filter);
    return response.json({ message: "Selected sessions signed out" });
  } catch (error) { return next(error); }
});

export default router;
