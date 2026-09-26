import { fromNodeHeaders } from "better-auth/node";

import { auth } from "./auth.js";
import { hasRecentVerification, isRecent, STAFF_SESSION_MS } from "./security-policy.js";

export async function readSession(request) {
  if (request.auth) return request.auth;
  const session = await auth.api.getSession({
    headers: fromNodeHeaders(request.headers),
  });
  request.auth = session;
  return session;
}

export async function readOptionalSession(request) {
  if (request.auth) return request.auth;
  if (!request.headers.cookie?.includes("better-auth")) return null;
  return readSession(request);
}

export async function requireVerifiedUser(request, response, next) {
  try {
    const session = await readSession(request);
    if (!session?.user) {
      return response.status(401).json({ message: "Sign in to continue" });
    }
    if (!session.user.emailVerified) {
      return response.status(403).json({ message: "Verify your email to continue" });
    }
    return next();
  } catch (error) {
    return next(error);
  }
}

export async function requireModerator(request, response, next) {
  try {
    const session = await readSession(request);
    const roles = String(session?.user?.role || "").split(",");
    if (!session?.user || !roles.some((role) => role === "moderator" || role === "admin")) {
      return response.status(403).json({ message: "Moderator access required" });
    }
    request.auth.effectiveRole = roles.includes("admin") ? "admin" : "moderator";
    if (!session.user.emailVerified || session.user.banned) {
      return response.status(403).json({ message: "A verified, active staff account is required" });
    }
    if (!isRecent(session.session?.createdAt, STAFF_SESSION_MS)) {
      return response.status(403).json({ code: "REAUTH_REQUIRED", message: "Sign out and sign in again to renew staff access" });
    }
    const maxAge = ["GET", "HEAD"].includes(request.method) ? STAFF_SESSION_MS : undefined;
    if (!session.user.twoFactorEnabled || !isRecent(session.session?.mfaVerifiedAt, maxAge)) {
      return response.status(403).json({ code: "MFA_REQUIRED", message: "Verify your authenticator code from Account security to use staff tools" });
    }
    return next();
  } catch (error) {
    return next(error);
  }
}

export function requireRecentAuth(request, response, next) {
  const session = request.auth;
  const recent = session?.user?.twoFactorEnabled
    ? hasRecentVerification(session)
    : isRecent(session?.session?.createdAt);
  if (!recent) {
    return response.status(403).json({ code: "REAUTH_REQUIRED", message: "Verify your authenticator code, or sign out and sign in again, before this action" });
  }
  return next();
}

export async function requireAdmin(request, response, next) {
  try {
    const session = await readSession(request);
    const roles = String(session?.user?.role || "").split(",");
    if (!session?.user || !roles.includes("admin")) {
      return response.status(403).json({ message: "Administrator access required" });
    }
    return next();
  } catch (error) {
    return next(error);
  }
}
