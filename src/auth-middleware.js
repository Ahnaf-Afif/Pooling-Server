import { fromNodeHeaders } from "better-auth/node";

import { auth, configuredRoleForEmail } from "./auth.js";

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
    const configuredRole = configuredRoleForEmail(session?.user?.email);
    const roles = String(session?.user?.role || configuredRole || "").split(",");
    if (!session?.user || !roles.some((role) => role === "moderator" || role === "admin")) {
      return response.status(403).json({ message: "Moderator access required" });
    }
    request.auth.effectiveRole = roles.includes("admin") ? "admin" : "moderator";
    return next();
  } catch (error) {
    return next(error);
  }
}

export async function requireAdmin(request, response, next) {
  try {
    const session = await readSession(request);
    const configuredRole = configuredRoleForEmail(session?.user?.email);
    const roles = String(session?.user?.role || configuredRole || "").split(",");
    if (!session?.user || !roles.includes("admin")) {
      return response.status(403).json({ message: "Administrator access required" });
    }
    return next();
  } catch (error) {
    return next(error);
  }
}
