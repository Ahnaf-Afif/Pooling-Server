import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

const COOKIE_NAME = "wdyt_voter";
const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

function secret() {
  return process.env.BETTER_AUTH_SECRET?.trim() || "development-only-secret-change-before-production-1234";
}

function signature(value) {
  return createHmac("sha256", secret()).update(value).digest("base64url");
}

export function getAccountVoterKey(userId) {
  return createHmac("sha256", secret()).update(`user:${userId}`).digest("hex");
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
    : `anonymous:${readSignedVoter(request) || createAnonymousVoter(response)}`;
  return createHmac("sha256", secret()).update(identity).digest("hex");
}

function createAnonymousVoter(response) {
  const value = randomUUID();
  setVoterCookie(response, value);
  return value;
}
