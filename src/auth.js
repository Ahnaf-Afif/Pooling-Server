import { mongodbAdapter } from "@better-auth/mongo-adapter";
import { betterAuth } from "better-auth";
import { admin, magicLink } from "better-auth/plugins";
import { defaultAc, userAc } from "better-auth/plugins/admin/access";

import { getClientOrigins } from "./config.js";
import { getMongoClient, getMongoDatabase } from "./db.js";

const splitList = (value) => new Set(
  String(value || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean),
);

const adminEmails = splitList(process.env.ADMIN_EMAILS);
const moderatorEmails = splitList(process.env.MODERATOR_EMAILS);
const authSecret = process.env.BETTER_AUTH_SECRET?.trim();
const authBaseUrl = process.env.BETTER_AUTH_URL?.trim();
if (process.env.NODE_ENV === "production" && (!authSecret || !authBaseUrl)) {
  throw new Error("BETTER_AUTH_SECRET and BETTER_AUTH_URL are required in production");
}
const googleConfigured = Boolean(
  process.env.GOOGLE_CLIENT_ID?.trim() && process.env.GOOGLE_CLIENT_SECRET?.trim(),
);
const magicLinkConfigured = Boolean(
  process.env.RESEND_API_KEY?.trim() && process.env.AUTH_EMAIL_FROM?.trim(),
);
const moderatorAc = defaultAc.newRole({ user: [], session: [] });
const adminAc = defaultAc.newRole({
  user: ["list", "get", "set-role", "ban"],
  session: [],
});
const disabledAdminPaths = [
  "/admin/create-user",
  "/admin/list-users",
  "/admin/get-user",
  "/admin/set-role",
  "/admin/set-user-password",
  "/admin/update-user",
  "/admin/ban-user",
  "/admin/unban-user",
  "/admin/list-user-sessions",
  "/admin/revoke-user-session",
  "/admin/revoke-user-sessions",
  "/admin/impersonate-user",
  "/admin/stop-impersonating",
  "/admin/remove-user",
  "/admin/has-permission",
];

function getVersionedSecrets() {
  const configured = process.env.BETTER_AUTH_SECRETS?.trim();
  if (!configured) return [{ version: 1, value: authSecret || "development-only-secret-change-before-production-1234" }];

  let secrets;
  try {
    secrets = JSON.parse(configured);
  } catch {
    throw new Error("BETTER_AUTH_SECRETS must be a JSON array of versioned secrets");
  }
  if (!Array.isArray(secrets) || !secrets.length || secrets.some(({ version, value } = {}) =>
    !Number.isSafeInteger(version) || version < 1 || typeof value !== "string" || value.length < 32)) {
    throw new Error("BETTER_AUTH_SECRETS contains an invalid version or secret");
  }
  return secrets;
}

async function sendMagicLink({ email, url }) {
  if (!magicLinkConfigured) {
    throw new Error("Email sign-in is not configured");
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY.trim()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: process.env.AUTH_EMAIL_FROM.trim(),
      to: [email],
      subject: "Sign in to What Do You Think?",
      html: `<div style="font-family:Arial,sans-serif;line-height:1.6;color:#111827"><h2>Sign in to What Do You Think?</h2><p>Use the secure link below to sign in. It expires in 10 minutes and can only be used once.</p><p><a href="${url}" style="display:inline-block;border-radius:999px;background:#1b4332;color:#fff;padding:12px 20px;text-decoration:none;font-weight:600">Sign in securely</a></p><p style="font-size:13px;color:#6b7280">If you did not request this email, you can ignore it.</p></div>`,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    console.error("Magic-link email failed:", response.status, error.slice(0, 300));
    throw new Error("Unable to send the sign-in email");
  }
}

const socialProviders = googleConfigured
  ? {
      google: {
        clientId: process.env.GOOGLE_CLIENT_ID.trim(),
        clientSecret: process.env.GOOGLE_CLIENT_SECRET.trim(),
      },
    }
  : {};

const plugins = [
  ...(magicLinkConfigured
    ? [magicLink({
        expiresIn: 60 * 10,
        rateLimit: { window: 60, max: 3 },
        storeToken: "hashed",
        sendMagicLink,
      })]
    : []),
  admin({
    defaultRole: "user",
    ac: defaultAc,
    roles: { user: userAc, moderator: moderatorAc, admin: adminAc },
    bannedUserMessage: "This account is suspended. Contact support if you think this is a mistake.",
  }),
];

export const auth = betterAuth({
  appName: "What Do You Think?",
  baseURL: authBaseUrl || "http://localhost:3000",
  secret: authSecret || "development-only-secret-change-before-production-1234",
  secrets: getVersionedSecrets(),
  database: mongodbAdapter(getMongoDatabase(), { client: getMongoClient() }),
  trustedOrigins: getClientOrigins(),
  disabledPaths: disabledAdminPaths,
  socialProviders,
  account: {
    encryptOAuthTokens: true,
  },
  session: {
    expiresIn: 60 * 60 * 24 * 30,
    updateAge: 60 * 60 * 24,
  },
  rateLimit: {
    enabled: true,
    window: 60,
    max: 100,
    storage: "database",
  },
  advanced: {
    database: { joins: true },
    trustedProxyHeaders: true,
    useSecureCookies: process.env.NODE_ENV === "production",
  },
  databaseHooks: {
    user: {
      create: {
        async after(user, context) {
          const email = user.email.toLowerCase();
          const role = adminEmails.has(email)
            ? "admin"
            : moderatorEmails.has(email)
              ? "moderator"
              : null;
          if (role && context) {
            await context.context.internalAdapter.updateUser(user.id, { role });
          }
        },
      },
    },
  },
  plugins,
});

export function getAuthConfiguration() {
  return {
    google: googleConfigured,
    magicLink: magicLinkConfigured,
  };
}
