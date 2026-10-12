"use server";

import { AuthError } from "next-auth";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { signIn, signOut } from "../../../../auth";
import { routing, type AppLocale } from "@/i18n/routing";
import { ensureDeviceId } from "@/platform/auth/device";
import { consumeLoginRateLimit, loginRateLimitIp } from "@/platform/auth/login-rate-limit";

export type LoginFormState = {
  status: "idle" | "error";
  messageKey?: "invalid" | "rateLimited" | "generic";
};

const loginSchema = z
  .object({
    method: z.enum(["password", "pin"]).default("password"),
    email: z.string().email().optional().or(z.literal("").transform(() => undefined)),
    phone: z.string().optional().or(z.literal("").transform(() => undefined)),
    password: z.string().optional().or(z.literal("").transform(() => undefined)),
    pin: z.string().optional().or(z.literal("").transform(() => undefined)),
    mfaCode: z.string().optional().or(z.literal("").transform(() => undefined)),
    recoveryCode: z.string().optional().or(z.literal("").transform(() => undefined))
  })
  .superRefine((value, ctx) => {
    if (value.method === "pin") {
      if (!value.phone || !value.pin) {
        ctx.addIssue({ code: "custom", message: "Phone and PIN are required" });
      }
      return;
    }

    if (!value.email || !value.password) {
      ctx.addIssue({ code: "custom", message: "Email and password are required" });
    }
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
    method: formData.get("method") === "pin" ? "pin" : "password",
    email: formData.get("email"),
    phone: formData.get("phone"),
    password: formData.get("password"),
    pin: formData.get("pin"),
    mfaCode: formData.get("mfaCode"),
    recoveryCode: formData.get("recoveryCode")
  });

  if (!parsed.success) {
    return { status: "error", messageKey: "invalid" };
  }

  const requestHeaders = await headers();
  const rateLimitKey =
    parsed.data.method === "pin"
      ? (parsed.data.phone ?? "").trim().toLowerCase()
      : (parsed.data.email ?? "").trim().toLowerCase();
  const rateLimit = await consumeLoginRateLimit(
    rateLimitKey,
    loginRateLimitIp(requestHeaders)
  );

  if (!rateLimit.allowed) {
    return { status: "error", messageKey: "rateLimited" };
  }

  const deviceId = await ensureDeviceId();
  const credentials: Record<string, string> = {
    method: parsed.data.method,
    deviceId,
    rateLimitChecked: "1"
  };

  for (const key of ["email", "phone", "password", "pin", "mfaCode", "recoveryCode"] as const) {
    const value = parsed.data[key];

    if (value) {
      credentials[key] = value;
    }
  }

  try {
    await signIn("credentials", {
      ...credentials,
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
