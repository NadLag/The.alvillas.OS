"use server";

import { AuthError } from "next-auth";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { signIn, signOut } from "../../../../auth";
import { routing, type AppLocale } from "@/i18n/routing";
import { consumeLoginRateLimit, loginRateLimitIp } from "@/platform/auth/login-rate-limit";

export type LoginFormState = {
  status: "idle" | "error";
  messageKey?: "invalid" | "rateLimited" | "generic";
};

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1)
});

function safeLocale(locale: string): AppLocale {
  return routing.locales.includes(locale as AppLocale) ? (locale as AppLocale) : routing.defaultLocale;
}

function authErrorCode(error: AuthError): string | undefined {
  const cause = error.cause as { err?: { code?: string } } | undefined;

  return cause?.err?.code;
}

export async function loginAction(
  locale: string,
  _state: LoginFormState,
  formData: FormData
): Promise<LoginFormState> {
  const appLocale = safeLocale(locale);
  const parsed = loginSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password")
  });

  if (!parsed.success) {
    return { status: "error", messageKey: "invalid" };
  }

  const requestHeaders = await headers();
  const rateLimit = await consumeLoginRateLimit(
    parsed.data.email.trim().toLowerCase(),
    loginRateLimitIp(requestHeaders)
  );

  if (!rateLimit.allowed) {
    return { status: "error", messageKey: "rateLimited" };
  }

  try {
    await signIn("credentials", {
      email: parsed.data.email,
      password: parsed.data.password,
      rateLimitChecked: "1",
      redirect: false
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return {
        status: "error",
        messageKey: authErrorCode(error) === "rate_limited" ? "rateLimited" : "invalid"
      };
    }

    throw error;
  }

  redirect(`/${appLocale}/app`);
}

export async function logoutAction(locale: string): Promise<void> {
  const appLocale = safeLocale(locale);

  await signOut({ redirectTo: `/${appLocale}/login` });
}
