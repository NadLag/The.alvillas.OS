"use server";

import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/types";
import { refresh, revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import type { ZodError } from "zod";
import {
  identityActorContextFromSession,
  IdentityAuthorizationError
} from "@/modules/identity/application/identity-access";
import {
  IdentityConflictError,
  IdentityNotFoundError,
  activateInvitation,
  assignRoleToAccount,
  beginPasskeyAuthentication,
  beginPasskeyRegistration,
  confirmTotpEnrollment,
  createCustomRole,
  createInvitation,
  createPersonProfile,
  deactivateAccount,
  finishPasskeyRegistration,
  issueRecoveryCode,
  parseActivationInput,
  parseCustomRoleInput,
  parseInvitationInput,
  parsePinResetInput,
  parsePersonProfileInput,
  parseRoleAssignmentInput,
  parseRecoveryInput,
  parseUpdatePersonProfileInput,
  parseUpdateCustomRoleInput,
  reactivateAccount,
  recoverPassword,
  resetAccountPin,
  revokeCredential,
  revokeDevice,
  revokeSession,
  startTotpEnrollment,
  suspendAccount,
  updatePersonProfile,
  updateCustomRole,
  verifyPasskeyAuthentication
} from "@/modules/identity/application/identity-service";
import { auth } from "@/platform/auth/session";
import { routing, type AppLocale } from "@/i18n/routing";

export type IdentityFormState = {
  status: "idle" | "success" | "error";
  messageKey?:
    | "validation"
    | "unauthorized"
    | "forbidden"
    | "notFound"
    | "conflict"
    | "generic"
    | "created"
    | "personCreated"
    | "personUpdated"
    | "roleCreated"
    | "roleUpdated"
    | "assignmentCreated"
    | "suspended"
    | "reactivated"
    | "deactivated"
    | "pinReset"
    | "recoveryIssued"
    | "recovered"
    | "revoked"
    | "totpStarted"
    | "totpConfirmed"
    | "passkeyRegistered"
    | "passkeyVerified";
  fieldErrors?: Record<string, string[]>;
  inviteCode?: string;
  recoveryCode?: string;
  totpCredentialId?: string;
  totpSecret?: string;
  totpUri?: string;
  recoveryCodes?: string[];
};

function safeLocale(locale: string): AppLocale {
  return routing.locales.includes(locale as AppLocale) ? (locale as AppLocale) : routing.defaultLocale;
}

function formValue(formData: FormData, key: string): FormDataEntryValue | undefined {
  return formData.get(key) ?? undefined;
}

function formValues(formData: FormData, key: string): string[] {
  return formData
    .getAll(key)
    .map((value) => (typeof value === "string" ? value : ""))
    .filter(Boolean);
}

function flattenZodError(error: ZodError): IdentityFormState {
  return {
    status: "error",
    messageKey: "validation",
    fieldErrors: error.flatten().fieldErrors
  };
}

function actionErrorState(error: unknown): IdentityFormState {
  if (error instanceof IdentityAuthorizationError) {
    return { status: "error", messageKey: "forbidden" };
  }

  if (error instanceof IdentityNotFoundError) {
    return { status: "error", messageKey: "notFound" };
  }

  if (error instanceof IdentityConflictError) {
    return { status: "error", messageKey: "conflict" };
  }

  return { status: "error", messageKey: "generic" };
}

async function identityContext(): Promise<Awaited<ReturnType<typeof identityActorContextFromSession>>> {
  return identityActorContextFromSession(await auth());
}

async function requestMeta() {
  const requestHeaders = await headers();

  return {
    requestId: requestHeaders.get("x-request-id") ?? crypto.randomUUID(),
    ipAddress: requestHeaders.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    origin: requestHeaders.get("origin") ?? undefined
  };
}

export async function createCustomRoleAction(
  locale: string,
  _state: IdentityFormState,
  formData: FormData
): Promise<IdentityFormState> {
  const appLocale = safeLocale(locale);
  const ctx = await identityContext();

  if (!ctx) {
    return { status: "error", messageKey: "unauthorized" };
  }

  const parsed = parseCustomRoleInput({
    key: formValue(formData, "key"),
    name: formValue(formData, "name"),
    description: formValue(formData, "description"),
    permissionKeys: formValues(formData, "permissionKeys")
  });

  if (!parsed.success) {
    return flattenZodError(parsed.error);
  }

  try {
    await createCustomRole(ctx, parsed.data, await requestMeta());
    revalidatePath(`/${appLocale}/app/identity`);
    refresh();

    return { status: "success", messageKey: "roleCreated" };
  } catch (error) {
    return actionErrorState(error);
  }
}

export async function updateCustomRoleAction(
  locale: string,
  roleId: string,
  _state: IdentityFormState,
  formData: FormData
): Promise<IdentityFormState> {
  const appLocale = safeLocale(locale);
  const ctx = await identityContext();

  if (!ctx) {
    return { status: "error", messageKey: "unauthorized" };
  }

  const parsed = parseUpdateCustomRoleInput({
    roleId,
    key: formValue(formData, "key"),
    name: formValue(formData, "name"),
    description: formValue(formData, "description"),
    permissionKeys: formValues(formData, "permissionKeys")
  });

  if (!parsed.success) {
    return flattenZodError(parsed.error);
  }

  try {
    await updateCustomRole(ctx, parsed.data, await requestMeta());
    revalidatePath(`/${appLocale}/app/identity`);
    refresh();

    return { status: "success", messageKey: "roleUpdated" };
  } catch (error) {
    return actionErrorState(error);
  }
}

export async function assignRoleAction(
  locale: string,
  _state: IdentityFormState,
  formData: FormData
): Promise<IdentityFormState> {
  const appLocale = safeLocale(locale);
  const ctx = await identityContext();

  if (!ctx) {
    return { status: "error", messageKey: "unauthorized" };
  }

  const parsed = parseRoleAssignmentInput({
    userAccountId: formValue(formData, "userAccountId"),
    roleId: formValue(formData, "roleId"),
    scopeType: formValue(formData, "scopeType") ?? "organization",
    scopeId: formValue(formData, "scopeId"),
    assignedToMe: formData.get("assignedToMe") === "on",
    statuses: formValue(formData, "statuses"),
    maxAmount: formValue(formData, "maxAmount"),
    conditionStartsAt: formValue(formData, "conditionStartsAt"),
    conditionEndsAt: formValue(formData, "conditionEndsAt"),
    validFrom: formValue(formData, "validFrom"),
    validTo: formValue(formData, "validTo"),
    compensationRef: formValue(formData, "compensationRef")
  });

  if (!parsed.success) {
    return flattenZodError(parsed.error);
  }

  try {
    await assignRoleToAccount(ctx, parsed.data, await requestMeta());
    revalidatePath(`/${appLocale}/app/identity`);
    refresh();

    return { status: "success", messageKey: "assignmentCreated" };
  } catch (error) {
    return actionErrorState(error);
  }
}

export async function createPersonProfileAction(
  locale: string,
  _state: IdentityFormState,
  formData: FormData
): Promise<IdentityFormState> {
  const appLocale = safeLocale(locale);
  const ctx = await identityContext();

  if (!ctx) {
    return { status: "error", messageKey: "unauthorized" };
  }

  const parsed = parsePersonProfileInput({
    displayName: formValue(formData, "displayName"),
    email: formValue(formData, "email"),
    phone: formValue(formData, "phone"),
    preferredLocale: formValue(formData, "preferredLocale") ?? "en"
  });

  if (!parsed.success) {
    return flattenZodError(parsed.error);
  }

  try {
    await createPersonProfile(ctx, parsed.data, await requestMeta());
    revalidatePath(`/${appLocale}/app/identity`);
    refresh();

    return { status: "success", messageKey: "personCreated" };
  } catch (error) {
    return actionErrorState(error);
  }
}

export async function updatePersonProfileAction(
  locale: string,
  personId: string,
  _state: IdentityFormState,
  formData: FormData
): Promise<IdentityFormState> {
  const appLocale = safeLocale(locale);
  const ctx = await identityContext();

  if (!ctx) {
    return { status: "error", messageKey: "unauthorized" };
  }

  const parsed = parseUpdatePersonProfileInput({
    personId,
    displayName: formValue(formData, "displayName"),
    email: formValue(formData, "email"),
    phone: formValue(formData, "phone"),
    preferredLocale: formValue(formData, "preferredLocale") ?? "en"
  });

  if (!parsed.success) {
    return flattenZodError(parsed.error);
  }

  try {
    await updatePersonProfile(ctx, parsed.data, await requestMeta());
    revalidatePath(`/${appLocale}/app/identity`);
    refresh();

    return { status: "success", messageKey: "personUpdated" };
  } catch (error) {
    return actionErrorState(error);
  }
}

export async function createInvitationAction(
  locale: string,
  _state: IdentityFormState,
  formData: FormData
): Promise<IdentityFormState> {
  const appLocale = safeLocale(locale);
  const ctx = await identityContext();

  if (!ctx) {
    return { status: "error", messageKey: "unauthorized" };
  }

  const parsed = parseInvitationInput({
    displayName: formValue(formData, "displayName"),
    email: formValue(formData, "email"),
    phone: formValue(formData, "phone"),
    roleKey: formValue(formData, "roleKey"),
    scopeType: formValue(formData, "scopeType") ?? "organization",
    scopeId: formValue(formData, "scopeId"),
    expiresInHours: formValue(formData, "expiresInHours") ?? "48"
  });

  if (!parsed.success) {
    return flattenZodError(parsed.error);
  }

  try {
    const invitation = await createInvitation(ctx, parsed.data, await requestMeta());
    revalidatePath(`/${appLocale}/app/identity`);

    return {
      status: "success",
      messageKey: "created",
      inviteCode: invitation.code
    };
  } catch (error) {
    return actionErrorState(error);
  }
}

export async function activateInvitationAction(
  locale: string,
  code: string,
  _state: IdentityFormState,
  formData: FormData
): Promise<IdentityFormState> {
  const appLocale = safeLocale(locale);
  const parsed = parseActivationInput({
    code,
    phone: formValue(formData, "phone"),
    pin: formValue(formData, "pin"),
    password: formValue(formData, "password")
  });

  if (!parsed.success) {
    return flattenZodError(parsed.error);
  }

  try {
    await activateInvitation(parsed.data, await requestMeta());
  } catch (error) {
    return actionErrorState(error);
  }

  redirect(`/${appLocale}/login`);
}

export async function suspendAccountAction(
  locale: string,
  userAccountId: string
): Promise<void> {
  const appLocale = safeLocale(locale);
  const ctx = await identityContext();

  if (!ctx) {
    redirect(`/${appLocale}/login`);
  }

  await suspendAccount(ctx, userAccountId, await requestMeta());
  revalidatePath(`/${appLocale}/app/identity`);
  refresh();
}

export async function reactivateAccountAction(
  locale: string,
  userAccountId: string
): Promise<void> {
  const appLocale = safeLocale(locale);
  const ctx = await identityContext();

  if (!ctx) {
    redirect(`/${appLocale}/login`);
  }

  await reactivateAccount(ctx, userAccountId, await requestMeta());
  revalidatePath(`/${appLocale}/app/identity`);
  refresh();
}

export async function deactivateAccountAction(
  locale: string,
  userAccountId: string
): Promise<void> {
  const appLocale = safeLocale(locale);
  const ctx = await identityContext();

  if (!ctx) {
    redirect(`/${appLocale}/login`);
  }

  await deactivateAccount(ctx, userAccountId, await requestMeta());
  revalidatePath(`/${appLocale}/app/identity`);
  refresh();
}

export async function resetPinAction(
  locale: string,
  userAccountId: string,
  _state: IdentityFormState,
  formData: FormData
): Promise<IdentityFormState> {
  const appLocale = safeLocale(locale);
  const ctx = await identityContext();

  if (!ctx) {
    return { status: "error", messageKey: "unauthorized" };
  }

  const parsed = parsePinResetInput({
    userAccountId,
    pin: formValue(formData, "pin")
  });

  if (!parsed.success) {
    return flattenZodError(parsed.error);
  }

  try {
    await resetAccountPin(ctx, parsed.data, await requestMeta());
    revalidatePath(`/${appLocale}/app/identity`);
    refresh();

    return { status: "success", messageKey: "pinReset" };
  } catch (error) {
    return actionErrorState(error);
  }
}

export async function issueRecoveryCodeAction(
  _locale: string,
  userAccountId: string,
  _state: IdentityFormState,
  _formData: FormData
): Promise<IdentityFormState> {
  void _state;
  void _formData;
  const ctx = await identityContext();

  if (!ctx) {
    return { status: "error", messageKey: "unauthorized" };
  }

  try {
    return {
      status: "success",
      messageKey: "recoveryIssued",
      recoveryCode: await issueRecoveryCode(ctx, userAccountId, await requestMeta())
    };
  } catch (error) {
    return actionErrorState(error);
  }
}

export async function recoverPasswordAction(
  locale: string,
  _state: IdentityFormState,
  formData: FormData
): Promise<IdentityFormState> {
  const appLocale = safeLocale(locale);
  const parsed = parseRecoveryInput({
    email: formValue(formData, "email"),
    recoveryCode: formValue(formData, "recoveryCode"),
    newPassword: formValue(formData, "newPassword")
  });

  if (!parsed.success) {
    return flattenZodError(parsed.error);
  }

  try {
    await recoverPassword(parsed.data, await requestMeta());
  } catch (error) {
    return actionErrorState(error);
  }

  redirect(`/${appLocale}/login`);
}

export async function revokeSessionAction(locale: string, sessionId: string): Promise<void> {
  const appLocale = safeLocale(locale);
  const ctx = await identityContext();

  if (!ctx) {
    redirect(`/${appLocale}/login`);
  }

  await revokeSession(ctx, sessionId, await requestMeta());
  revalidatePath(`/${appLocale}/app/identity`);
  refresh();
}

export async function revokeDeviceAction(locale: string, deviceRecordId: string): Promise<void> {
  const appLocale = safeLocale(locale);
  const ctx = await identityContext();

  if (!ctx) {
    redirect(`/${appLocale}/login`);
  }

  await revokeDevice(ctx, deviceRecordId, await requestMeta());
  revalidatePath(`/${appLocale}/app/identity`);
  refresh();
}

export async function revokeCredentialAction(locale: string, credentialId: string): Promise<void> {
  const appLocale = safeLocale(locale);
  const ctx = await identityContext();

  if (!ctx) {
    redirect(`/${appLocale}/login`);
  }

  await revokeCredential(ctx, credentialId, await requestMeta());
  revalidatePath(`/${appLocale}/app/identity`);
  refresh();
}

export async function startTotpEnrollmentAction(): Promise<IdentityFormState> {
  const ctx = await identityContext();

  if (!ctx) {
    return { status: "error", messageKey: "unauthorized" };
  }

  try {
    const enrollment = await startTotpEnrollment(ctx, await requestMeta());

    return {
      status: "success",
      messageKey: "totpStarted",
      totpCredentialId: enrollment.credentialId,
      totpSecret: enrollment.secret,
      totpUri: enrollment.uri
    };
  } catch (error) {
    return actionErrorState(error);
  }
}

export async function confirmTotpEnrollmentAction(
  credentialId: string,
  code: string
): Promise<IdentityFormState> {
  const ctx = await identityContext();

  if (!ctx) {
    return { status: "error", messageKey: "unauthorized" };
  }

  try {
    return {
      status: "success",
      messageKey: "totpConfirmed",
      recoveryCodes: await confirmTotpEnrollment(ctx, credentialId, code, await requestMeta())
    };
  } catch (error) {
    return actionErrorState(error);
  }
}

export async function beginPasskeyRegistrationAction() {
  const ctx = await identityContext();

  if (!ctx) {
    throw new IdentityAuthorizationError();
  }

  return beginPasskeyRegistration(ctx, await requestMeta());
}

export async function finishPasskeyRegistrationAction(
  challengeId: string,
  response: RegistrationResponseJSON
): Promise<IdentityFormState> {
  const ctx = await identityContext();

  if (!ctx) {
    return { status: "error", messageKey: "unauthorized" };
  }

  try {
    await finishPasskeyRegistration(ctx, challengeId, response, await requestMeta());

    return { status: "success", messageKey: "passkeyRegistered" };
  } catch (error) {
    return actionErrorState(error);
  }
}

export async function beginPasskeyAuthenticationAction(email: string): Promise<{
  challengeId: string;
  options: Awaited<ReturnType<typeof beginPasskeyAuthentication>>["options"];
}> {
  return beginPasskeyAuthentication(email.trim().toLowerCase(), await requestMeta());
}

export async function verifyPasskeyAuthenticationAction(
  email: string,
  challengeId: string,
  response: AuthenticationResponseJSON
): Promise<IdentityFormState> {
  try {
    await verifyPasskeyAuthentication(email.trim().toLowerCase(), challengeId, response, await requestMeta());

    return { status: "success", messageKey: "passkeyVerified" };
  } catch (error) {
    return actionErrorState(error);
  }
}
