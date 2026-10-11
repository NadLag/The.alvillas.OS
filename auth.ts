import NextAuth, { CredentialsSignin } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { z } from "zod";
import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransactionRunner } from "@/platform/db/tenant";
import { bootstrapOrganizationId } from "@/platform/identity/bootstrap";
import { consumeLoginRateLimit, loginRateLimitIp } from "@/platform/auth/login-rate-limit";
import { verifyPassword } from "@/platform/auth/password";

const authSecret =
  process.env.AUTH_SECRET ??
  (process.env.NODE_ENV === "production" ? undefined : "dev-only-alvillas-os-auth-secret");

const credentialsSchema = z.object({
  email: z.string().email().transform((email) => email.trim().toLowerCase()),
  password: z.string().min(1),
  rateLimitChecked: z.literal("1").optional()
});

type AuthorizedUser = {
  id: string;
  personId: string;
  email: string;
  name: string;
  organizationId: string;
  preferredLocale: string;
};

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
  credentials: Partial<Record<"email" | "password", unknown>>,
  request: Request
): Promise<AuthorizedUser> {
  const parsed = credentialsSchema.safeParse(credentials);

  if (!parsed.success) {
    throw new InvalidCredentialsSignin();
  }

  const { email, password } = parsed.data;

  if (parsed.data.rateLimitChecked !== "1") {
    const rateLimit = await consumeLoginRateLimit(email, loginRateLimitIp(request.headers));

    if (!rateLimit.allowed) {
      throw new RateLimitedSignin();
    }
  }

  const account = await withTenant(
    prisma as unknown as TenantTransactionRunner,
    bootstrapOrganizationId,
    async (tx) =>
      tx.userAccount.findFirst({
        where: {
          email,
          status: "ACTIVE"
        },
        include: {
          person: true
        }
      })
  );

  if (!account?.passwordHash) {
    throw new InvalidCredentialsSignin();
  }

  const passwordMatches = await verifyPassword(password, account.passwordHash);

  if (!passwordMatches) {
    throw new InvalidCredentialsSignin();
  }

  await withTenant(prisma as unknown as TenantTransactionRunner, bootstrapOrganizationId, async (tx) =>
    tx.userAccount.update({
      where: { id: account.id },
      data: { lastLoginAt: new Date() }
    })
  );

  return {
    id: account.id,
    personId: account.personId,
    email: account.email ?? email,
    name: account.person.displayName,
    organizationId: account.organizationId,
    preferredLocale: account.person.preferredLocale
  };
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
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" }
      },
      async authorize(credentials, request) {
        return authorizeCredentials(credentials, request);
      }
    })
  ],
  callbacks: {
    jwt({ token, user }) {
      if (user) {
        const authorizedUser = user as AuthorizedUser;
        token.userId = authorizedUser.id;
        token.personId = authorizedUser.personId;
        token.organizationId = authorizedUser.organizationId;
        token.preferredLocale = authorizedUser.preferredLocale;
      }

      return token;
    },
    session({ session, token }) {
      if (session.user) {
        session.user.id = tokenString(token.userId, tokenString(token.sub, ""));
        session.user.personId = tokenString(token.personId, "");
        session.user.organizationId = tokenString(token.organizationId, "");
        session.user.preferredLocale = tokenString(token.preferredLocale, "en");
      }

      return session;
    }
  }
});
