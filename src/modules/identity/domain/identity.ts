import { z } from "zod";
import { permissionKey, type Action } from "@/platform/authz/authorize";
import {
  standardRoleKeys,
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

export const invitationInputSchema = z.object({
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
  roleKey: z.enum(standardRoleKeys),
  scopeType: z
    .enum([
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
    ])
    .default("organization"),
  scopeId: z
    .string()
    .uuid()
    .optional()
    .or(z.literal("").transform(() => undefined)),
  expiresInHours: z.coerce.number().int().min(1).max(168).default(48)
});

export type InvitationInput = z.infer<typeof invitationInputSchema>;

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

export function identityActionForMutation(
  mutation: "invite" | "suspend" | "recover" | "revoke" | "mfa"
): Action {
  switch (mutation) {
    case "invite":
      return "create";
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
