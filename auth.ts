import NextAuth, { CredentialsSignin } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { z } from "zod";
import { consumeLoginRateLimit, loginRateLimitIp } from "@/platform/auth/login-rate-limit";
import {
  authenticatePassword,
  authenticatePin,
  validateAuthSession,
  type AuthorizedIdentityUser
} from "@/platform/auth/identity-auth";

const authSecret =
  process.env.AUTH_SECRET ??
  (process.env.NODE_ENV === "production" ? undefined : "dev-only-alvillas-os-auth-secret");

const emptyString = z.literal("").transform(() => undefined);
const optionalTrimmedString = z
  .string()
  .transform((value) => value.trim())
  .optional()
  .or(emptyString);

const credentialsSchema = z.object({
  method: z.enum(["password", "pin"]).default("password"),
  email: z
    .string()
    .trim()
    .email()
    .transform((email) => email.toLowerCase())
    .optional()
    .or(emptyString),
  phone: z
    .string()
    .trim()
    .min(6)
    .transform((phone) => phone.toLowerCase())
    .optional()
    .or(emptyString),
  password: optionalTrimmedString,
  pin: optionalTrimmedString,
  mfaCode: optionalTrimmedString,
  recoveryCode: optionalTrimmedString,
  deviceId: optionalTrimmedString.default("server-action-device-default"),
  rateLimitChecked: z.literal("1").optional()
});

class InvalidCredentialsSignin extends CredentialsSignin {
  code = "invalid_credentials";
}

class RateLimitedSignin extends CredentialsSignin {
  code = "rate_limited";
}

function tokenString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

async function authorizeCredentials(
  credentials: Partial<Record<string, unknown>>,
  request: Request
): Promise<AuthorizedIdentityUser> {
  const parsed = credentialsSchema.safeParse(credentials);

  if (!parsed.success) {
    throw new InvalidCredentialsSignin();
  }

  const rateLimitKey =
    parsed.data.method === "pin" ? (parsed.data.phone ?? "missing-phone") : (parsed.data.email ?? "missing-email");

  if (parsed.data.rateLimitChecked !== "1") {
    const rateLimit = await consumeLoginRateLimit(rateLimitKey, loginRateLimitIp(request.headers));

    if (!rateLimit.allowed) {
      throw new RateLimitedSignin();
    }
  }

  const authorizedUser =
    parsed.data.method === "pin"
      ? parsed.data.phone && parsed.data.pin
        ? await authenticatePin({
            phone: parsed.data.phone,
            pin: parsed.data.pin,
            deviceId: parsed.data.deviceId,
            headers: request.headers
          })
        : null
      : parsed.data.email && parsed.data.password
        ? await authenticatePassword({
            email: parsed.data.email,
            password: parsed.data.password,
            mfaCode: parsed.data.mfaCode,
            recoveryCode: parsed.data.recoveryCode,
            deviceId: parsed.data.deviceId,
            headers: request.headers
          })
        : null;

  if (!authorizedUser) {
    throw new InvalidCredentialsSignin();
  }

  return authorizedUser;
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  trustHost: true,
  secret: authSecret,
  useSecureCookies: process.env.NODE_ENV === "production",
  pages: {
    signIn: "/en/login"
  },
  session: {
    strategy: "jwt",
    maxAge: 8 * 60 * 60,
    updateAge: 15 * 60
  },
  providers: [
    Credentials({
      credentials: {
        method: { label: "Method", type: "text" },
        email: { label: "Email", type: "email" },
        phone: { label: "Phone", type: "text" },
        password: { label: "Password", type: "password" },
        pin: { label: "PIN", type: "password" },
        mfaCode: { label: "MFA code", type: "text" },
        recoveryCode: { label: "Recovery code", type: "text" },
        deviceId: { label: "Device", type: "text" },
        rateLimitChecked: { label: "Rate limit checked", type: "text" }
      },
      async authorize(credentials, request) {
        return authorizeCredentials(credentials, request);
      }
    })
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        const authorizedUser = user as AuthorizedIdentityUser;
        token.userId = authorizedUser.id;
        token.personId = authorizedUser.personId;
        token.organizationId = authorizedUser.organizationId;
        token.preferredLocale = authorizedUser.preferredLocale;
        token.authSessionId = authorizedUser.sessionId;
        token.sessionVersion = authorizedUser.sessionVersion;
        token.sessionRevoked = false;
      } else if (
        typeof token.userId === "string" &&
        typeof token.organizationId === "string" &&
        typeof token.authSessionId === "string" &&
        typeof token.sessionVersion === "number"
      ) {
        const validation = await validateAuthSession({
          organizationId: token.organizationId,
          userAccountId: token.userId,
          sessionId: token.authSessionId,
          sessionVersion: token.sessionVersion
        });

        token.sessionRevoked = !validation.valid;

        if (validation.valid && validation.preferredLocale) {
          token.preferredLocale = validation.preferredLocale;
        }
      }

      return token;
    },
    session({ session, token }) {
      if (session.user) {
        const revoked = token.sessionRevoked === true;
        session.user.id = revoked ? "" : tokenString(token.userId, tokenString(token.sub, ""));
        session.user.personId = revoked ? "" : tokenString(token.personId, "");
        session.user.organizationId = revoked ? "" : tokenString(token.organizationId, "");
        session.user.preferredLocale = tokenString(token.preferredLocale, "en");
        session.user.sessionId = revoked ? "" : tokenString(token.authSessionId, "");
        session.user.sessionRevoked = revoked;
      }

      return session;
    }
  }
});
