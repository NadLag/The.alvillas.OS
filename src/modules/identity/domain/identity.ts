import { z } from "zod";
import { permissionKey, type Action } from "@/platform/authz/authorize";

export const identityResource = "identity";

export const identityPermissions = [
  permissionKey(identityResource, "view"),
  permissionKey(identityResource, "create"),
  permissionKey(identityResource, "edit"),
  permissionKey(identityResource, "assign"),
  permissionKey(identityResource, "configure"),
  permissionKey(identityResource, "override")
] as const;

export const standardPermissions = [
  ...identityPermissions,
  permissionKey("owner", "view"),
  permissionKey("owner", "create"),
  permissionKey("property", "view"),
  permissionKey("property", "create"),
  permissionKey("reservation", "view"),
  permissionKey("reservation", "create"),
  permissionKey("task", "view"),
  permissionKey("task", "create"),
  permissionKey("task", "edit"),
  permissionKey("task", "validate"),
  permissionKey("financial_transaction", "view"),
  permissionKey("financial_transaction", "create"),
  permissionKey("financial_transaction", "void"),
  permissionKey("financial_transaction", "reconcile"),
  permissionKey("owner_portal", "view"),
  permissionKey("owner_portal_property", "view"),
  permissionKey("owner_statement", "view")
] as const;

export type StandardRoleKey = "admin" | "finance" | "field_staff" | "owner";

export const standardRoles: Array<{
  key: StandardRoleKey;
  name: string;
  permissions: readonly string[];
  mfaRequired: boolean;
}> = [
  {
    key: "admin",
    name: "Administrator",
    permissions: standardPermissions,
    mfaRequired: true
  },
  {
    key: "finance",
    name: "Finance",
    permissions: [
      permissionKey(identityResource, "view"),
      permissionKey("reservation", "view"),
      permissionKey("financial_transaction", "view"),
      permissionKey("financial_transaction", "create"),
      permissionKey("financial_transaction", "void"),
      permissionKey("financial_transaction", "reconcile")
    ],
    mfaRequired: true
  },
  {
    key: "field_staff",
    name: "Field staff",
    permissions: [permissionKey("task", "view"), permissionKey("task", "edit")],
    mfaRequired: false
  },
  {
    key: "owner",
    name: "Owner",
    permissions: [
      permissionKey("owner_portal", "view"),
      permissionKey("owner_portal_property", "view"),
      permissionKey("owner_statement", "view")
    ],
    mfaRequired: false
  }
];

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
  roleKey: z.enum(["admin", "finance", "field_staff", "owner"]),
  scopeType: z.enum(["organization", "property", "owner", "field_team"]).default("organization"),
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
