import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      organizationId: string;
      preferredLocale: string;
    } & DefaultSession["user"];
  }

  interface User {
    organizationId?: string;
    preferredLocale?: string;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    userId?: string;
    organizationId?: string;
    preferredLocale?: string;
  }
}
