import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      personId: string;
      organizationId: string;
      preferredLocale: string;
    } & DefaultSession["user"];
  }

  interface User {
    personId?: string;
    organizationId?: string;
    preferredLocale?: string;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    userId?: string;
    personId?: string;
    organizationId?: string;
    preferredLocale?: string;
  }
}
