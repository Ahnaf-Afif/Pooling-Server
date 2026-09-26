export const STEP_UP_MS = 15 * 60 * 1000;
export const STAFF_SESSION_MS = 12 * 60 * 60 * 1000;

export function isRecent(value, maxAge = STEP_UP_MS) {
  const timestamp = new Date(value || 0).getTime();
  const age = Date.now() - timestamp;
  return Number.isFinite(age) && age >= 0 && age < maxAge;
}

export function hasRecentVerification(session) {
  return Boolean(session?.user?.twoFactorEnabled && isRecent(session?.session?.mfaVerifiedAt));
}

export function isStaff(user) {
  return String(user?.role || "").split(",").some((role) => role === "admin" || role === "moderator");
}
