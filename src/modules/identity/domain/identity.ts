import { z } from "zod";
import { permissionKey, type Action } from "@/platform/authz/authorize";
import {
  permissionCatalog,
  standardRoleTemplates,
  standardPermissions as catalogStandardPermissions,
  type StandardRoleKey
} from "@/platform/authz/catalog";

export const identityResource = "identity";

export const identityPermissions = [
  permissionKey(identityResource, "view"),
  permissionKey(identityResource, "create"),
  permissionKey(identityResource, "edit"),
  permissionKey(identityResource, "assign"),
  permissionKey(identityResource, "configure"),
  permissionKey(identityResource, "override")
] as const;

export const standardPermissions = catalogStandardPermissions;
export const standardRoles = standardRoleTemplates;
export type { StandardRoleKey };

const roleKeySchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z][a-z0-9_]{2,63}$/u, "Use lowercase letters, numbers, and underscores");

const permissionKeys = permissionCatalog.map((permission) => permission.key) as [string, ...string[]];

export const permissionKeySchema = z.enum(permissionKeys);

export const scopeTypes = [
  "organization",
  "region",
  "city",
  "property",
  "owner",
  "reservation",
  "job",
  "service",
  "financial_record",
  "wallet",
  "field_team"
] as const;

export const scopeTypeSchema = z.enum(scopeTypes);

export const invitationInputSchema = z.object({
  personId: z.string().uuid().optional().or(z.literal("").transform(() => undefined)),
  displayName: z.string().trim().min(2).max(120),
  email: z
    .string()
    .trim()
    .email()
    .transform((value) => value.toLowerCase())
    .optional()
    .or(z.literal("").transform(() => undefined)),
  phone: z
    .string()
    .trim()
    .min(6)
    .max(32)
    .transform((value) => value.toLowerCase())
    .optional()
    .or(z.literal("").transform(() => undefined)),
  roleKey: roleKeySchema,
  preferredLocale: z.enum(["en", "fr", "ar"]).optional(),
  scopeType: scopeTypeSchema.default("organization"),
  scopeId: z
    .string()
    .uuid()
    .optional()
    .or(z.literal("").transform(() => undefined)),
  expiresInHours: z.coerce.number().int().min(1).max(168).default(48)
});

export type InvitationInput = z.infer<typeof invitationInputSchema>;

export const personProfileInputSchema = z.object({
  displayName: z.string().trim().min(2).max(120),
  email: z
    .string()
    .trim()
    .email()
    .transform((value) => value.toLowerCase())
    .optional()
    .or(z.literal("").transform(() => undefined)),
  phone: z
    .string()
    .trim()
    .min(6)
    .max(32)
    .transform((value) => value.toLowerCase())
    .optional()
    .or(z.literal("").transform(() => undefined)),
  preferredLocale: z.enum(["en", "fr", "ar"]).default("en")
});

export const updatePersonProfileInputSchema = personProfileInputSchema.extend({
  personId: z.string().uuid()
});

export type PersonProfileInput = z.infer<typeof personProfileInputSchema>;
export type UpdatePersonProfileInput = z.infer<typeof updatePersonProfileInputSchema>;

export const updateAccountEmailInputSchema = z.object({
  accountId: z.string().uuid(), personId: z.string().uuid(),
  email: z.string().trim().email().transform((value) => value.toLowerCase()),
  expectedEmail: z.string().trim().email().transform((value) => value.toLowerCase()),
  reason: z.string().trim().min(8).max(500)
}).strict();
export type UpdateAccountEmailInput = z.infer<typeof updateAccountEmailInputSchema>;

export const customRoleInputSchema = z.object({
  key: roleKeySchema,
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(500).optional().or(z.literal("").transform(() => undefined)),
  permissionKeys: z.array(permissionKeySchema).min(1).max(permissionCatalog.length)
});

export type CustomRoleInput = z.infer<typeof customRoleInputSchema>;

export const updateCustomRoleInputSchema = customRoleInputSchema.extend({
  roleId: z.string().uuid()
});

export type UpdateCustomRoleInput = z.infer<typeof updateCustomRoleInputSchema>;

const optionalDateSchema = z
  .string()
  .trim()
  .optional()
  .or(z.literal("").transform(() => undefined))
  .transform((value, ctx) => {
    if (!value) {
      return undefined;
    }

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
      ctx.addIssue({
        code: "custom",
        message: "Invalid date"
      });
      return z.NEVER;
    }

    return date;
  });

const optionalDecimalSchema = z
  .string()
  .trim()
  .transform((value) => (value === "" ? undefined : value))
  .optional()
  .refine((value) => value === undefined || /^\d+(\.\d{1,2})?$/u.test(value), {
    message: "Use a positive amount with up to two decimals"
  });

function assignmentConditionWindowIsOrdered(value: {
  conditionStartsAt?: Date;
  conditionEndsAt?: Date;
}): boolean {
  return (
    !value.conditionStartsAt ||
    !value.conditionEndsAt ||
    value.conditionEndsAt.getTime() > value.conditionStartsAt.getTime()
  );
}

export const roleAssignmentInputSchema = z
  .object({
    userAccountId: z.string().uuid(),
    roleId: z.string().uuid(),
    scopeType: scopeTypeSchema.default("organization"),
    scopeId: z.string().uuid().optional().or(z.literal("").transform(() => undefined)),
    assignedToMe: z.coerce.boolean().optional().default(false),
    statuses: z
      .string()
      .trim()
      .optional()
      .or(z.literal("").transform(() => undefined))
      .transform((value) =>
        value
          ? value
              .split(",")
              .map((status) => status.trim())
              .filter(Boolean)
          : []
      ),
    maxAmount: optionalDecimalSchema,
    conditionStartsAt: optionalDateSchema,
    conditionEndsAt: optionalDateSchema,
    validFrom: optionalDateSchema,
    validTo: optionalDateSchema,
    compensationRef: z.string().trim().max(120).optional().or(z.literal("").transform(() => undefined))
  })
  .refine((value) => value.scopeType === "organization" || Boolean(value.scopeId), {
    path: ["scopeId"],
    message: "A scope id is required for scoped assignments"
  })
  .refine((value) => !value.validFrom || !value.validTo || value.validTo.getTime() > value.validFrom.getTime(), {
    path: ["validTo"],
    message: "Valid to must be after valid from"
  })
  .refine(assignmentConditionWindowIsOrdered, {
    path: ["conditionEndsAt"],
    message: "Condition end must be after condition start"
  });

export type RoleAssignmentInput = z.infer<typeof roleAssignmentInputSchema>;

export const activationInputSchema = z
  .object({
    code: z.string().trim().min(12),
    phone: z.string().trim().min(6).max(32).transform((value) => value.toLowerCase()),
    pin: z.string().trim().regex(/^\d{6}$/u, "PIN must be six digits"),
    password: z.string().min(12).optional().or(z.literal("").transform(() => undefined))
  })
  .refine((value) => value.password || value.pin, {
    path: ["password"],
    message: "Password or PIN is required"
  });

export type ActivationInput = z.infer<typeof activationInputSchema>;

export const recoveryInputSchema = z.object({
  email: z.string().trim().email().transform((value) => value.toLowerCase()),
  recoveryCode: z.string().trim().min(8),
  newPassword: z.string().min(12)
});

export type RecoveryInput = z.infer<typeof recoveryInputSchema>;

export const pinResetInputSchema = z.object({
  userAccountId: z.string().uuid(),
  pin: z.string().trim().regex(/^\d{6}$/u, "PIN must be six digits")
});

export type PinResetInput = z.infer<typeof pinResetInputSchema>;

export function identityActionForMutation(
  mutation: "invite" | "suspend" | "deactivate" | "recover" | "revoke" | "mfa"
): Action {
  switch (mutation) {
    case "invite":
      return "create";
    case "deactivate":
    case "revoke":
      return "override";
    case "mfa":
      return "configure";
    case "recover":
      return "edit";
    case "suspend":
      return "assign";
  }
}
