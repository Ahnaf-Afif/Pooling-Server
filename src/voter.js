import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

const COOKIE_NAME = "wdyt_voter";
const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;
const anonymousIdentity = Symbol("anonymousVoter");

export function getVoterSecret() {
  const configured = process.env.VOTER_SECRET?.trim();
  if (configured && configured.length < 32) throw new Error("VOTER_SECRET must contain at least 32 characters");
  if (!configured && process.env.NODE_ENV === "production") {
    throw new Error("VOTER_SECRET is required in production; preserve the existing voter key before rotating auth secrets");
  }
  // Local development stays compatible with existing local vote receipts.
  return configured || process.env.BETTER_AUTH_SECRET?.trim() || "development-only-secret-change-before-production-1234";
}

function signature(value) {
  return createHmac("sha256", getVoterSecret()).update(value).digest("base64url");
}

export function getAccountVoterKey(userId) {
  return createHmac("sha256", getVoterSecret()).update(`user:${userId}`).digest("hex");
}

function parseCookies(header = "") {
  return Object.fromEntries(
    header.split(";").map((part) => {
      const index = part.indexOf("=");
      if (index === -1) return [part.trim(), ""];
      const rawValue = part.slice(index + 1);
      try {
        return [part.slice(0, index).trim(), decodeURIComponent(rawValue)];
      } catch {
        return [part.slice(0, index).trim(), rawValue];
      }
    }),
  );
}

function readSignedVoter(request) {
  const [value, suppliedSignature, extra] = (parseCookies(request.headers.cookie)[COOKIE_NAME] || "").split(".");
  if (!/^[0-9a-f-]{36}$/.test(value || "") || !/^[A-Za-z0-9_-]{43}$/.test(suppliedSignature || "") || extra !== undefined) return null;
  const expected = signature(value);
  return timingSafeEqual(Buffer.from(suppliedSignature), Buffer.from(expected)) ? value : null;
}

function setVoterCookie(response, value) {
  response.cookie(COOKIE_NAME, `${value}.${signature(value)}`, {
    httpOnly: true,
    maxAge: ONE_YEAR_SECONDS * 1000,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
  });
}

export function getVoterKey(request, response, session) {
  const identity = session?.user?.id
    ? `user:${session.user.id}`
    : `anonymous:${request[anonymousIdentity] ||= readSignedVoter(request) || createAnonymousVoter(response)}`;
  return createHmac("sha256", getVoterSecret()).update(identity).digest("hex");
}

function createAnonymousVoter(response) {
  const value = randomUUID();
  setVoterCookie(response, value);
  return value;
}
