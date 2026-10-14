"use server";

import { AuthError } from "next-auth";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { auth, signIn, signOut } from "../../../../auth";
import { appLocales, safeLocale } from "@/i18n/routing";
import { identityActorContextFromSession } from "@/modules/identity/application/identity-access";
import { updateOwnPreferredLocale } from "@/modules/identity/application/identity-service";
import { ensureDeviceId } from "@/platform/auth/device";
import { beginPasswordMfaChallenge, preferredLocaleForLogin } from "@/platform/auth/identity-auth";
import { consumeLoginRateLimit, loginRateLimitIp, withCheckedLoginRateLimit } from "@/platform/auth/login-rate-limit";

export type LoginFormState = {
  status: "idle" | "error" | "mfaRequired";
  messageKey?: "invalid" | "mfaInvalid" | "rateLimited" | "generic";
  email?: string;
  mfaChallenge?: string;
};

const emptyFormValue = z.union([z.literal(""), z.null()]).transform(() => undefined);
const optionalFormString = z.string().optional().or(emptyFormValue);

const loginSchema = z
  .object({
    method: z.enum(["password", "pin", "mfa"]).default("password"),
    email: z.string().email().optional().or(emptyFormValue),
    phone: optionalFormString,
    password: optionalFormString,
    pin: optionalFormString,
    mfaCode: optionalFormString,
    recoveryCode: optionalFormString,
    mfaChallenge: optionalFormString
  })
  .superRefine((value, ctx) => {
    if (value.method === "mfa") {
      if (!value.email || !value.mfaChallenge || (!value.mfaCode && !value.recoveryCode)) {
        ctx.addIssue({ code: "custom", message: "MFA challenge and code are required" });
      }
      return;
    }

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

const preferredLocaleSchema = z.object({
  preferredLocale: z.enum(appLocales)
});

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
  const requestedMethod = formData.get("method");
  const method =
    requestedMethod === "mfa" || formData.get("mfaChallenge")
      ? "mfa"
      : requestedMethod === "pin"
        ? "pin"
        : "password";
  const parsed = loginSchema.safeParse({
    method,
    email: formData.get("email"),
    phone: formData.get("phone"),
    password: formData.get("password"),
    pin: formData.get("pin"),
    mfaCode: formData.get("mfaCode"),
    recoveryCode: formData.get("recoveryCode"),
    mfaChallenge: formData.get("mfaChallenge")
  });

  if (!parsed.success) {
    const rawEmail = formData.get("email");
    const rawMfaChallenge = formData.get("mfaChallenge");
    const email = typeof rawEmail === "string" ? rawEmail : undefined;
    const mfaChallenge = typeof rawMfaChallenge === "string" ? rawMfaChallenge : undefined;

    if (method === "mfa" && email && mfaChallenge) {
      return { status: "mfaRequired", messageKey: "mfaInvalid", email, mfaChallenge };
    }

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
    deviceId
  };

  for (const key of [
    "email",
    "phone",
    "password",
    "pin",
    "mfaCode",
    "recoveryCode",
    "mfaChallenge"
  ] as const) {
    const value = parsed.data[key];

    if (value) {
      credentials[key] = value;
    }
  }

  try {
    await withCheckedLoginRateLimit(rateLimitKey, loginRateLimitIp(requestHeaders), () =>
      signIn("credentials", { ...credentials, redirect: false })
    );
  } catch (error) {
    if (error instanceof AuthError) {
      if (parsed.data.method === "mfa" && parsed.data.email && parsed.data.mfaChallenge) {
        return {
          status: "mfaRequired",
          messageKey: authErrorCode(error) === "rate_limited" ? "rateLimited" : "mfaInvalid",
          email: parsed.data.email,
          mfaChallenge: parsed.data.mfaChallenge
        };
      }

      if (parsed.data.method === "password" && parsed.data.email && parsed.data.password) {
        const mfaChallenge = await beginPasswordMfaChallenge({
          email: parsed.data.email,
          password: parsed.data.password,
          deviceId
        });

        if (mfaChallenge.status === "mfa_required") {
          return {
            status: "mfaRequired",
            email: mfaChallenge.email,
            mfaChallenge: mfaChallenge.challengeToken
          };
        }
      }

      return {
        status: "error",
        messageKey: authErrorCode(error) === "rate_limited" ? "rateLimited" : "invalid"
      };
    }

    throw error;
  }

  redirect(
    `/${await preferredLocaleForLogin({
      email: parsed.data.email,
      phone: parsed.data.phone
    }, appLocale)}/app`
  );
}

export async function logoutAction(locale: string): Promise<void> {
  const appLocale = safeLocale(locale);

  await signOut({ redirectTo: `/${appLocale}/login` });
}

export async function updatePreferredLocaleAction(locale: string, formData: FormData): Promise<void> {
  const appLocale = safeLocale(locale);
  const parsed = preferredLocaleSchema.safeParse({
    preferredLocale: formData.get("preferredLocale")
  });

  if (!parsed.success) {
    redirect(`/${appLocale}/app`);
  }

  const session = await auth();
  const ctx = await identityActorContextFromSession(session);

  if (!ctx) {
    redirect(`/${appLocale}/login`);
  }

  const requestHeaders = await headers();
  await updateOwnPreferredLocale(ctx, parsed.data.preferredLocale, {
    ipAddress: loginRateLimitIp(requestHeaders),
    requestId: requestHeaders.get("x-request-id") ?? undefined
  });

  redirect(`/${parsed.data.preferredLocale}/app`);
}
