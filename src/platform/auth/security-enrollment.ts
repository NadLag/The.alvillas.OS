import { standardRoleTemplates } from "@/platform/authz/catalog";

const mandatoryRoles = new Set<string>(standardRoleTemplates.filter((role) => role.mfaRequired).map((role) => role.key));

export type SecurityEnrollmentAccount = {
  mfaRequired: boolean;
  roleAssignments: Array<{ role: { key: string } }>;
  authCredentials: Array<{ type: string; revokedAt?: Date | null; expiresAt?: Date | null }>;
};

export function securityEnrollment(account: SecurityEnrollmentAccount, now = new Date()) {
  const mandatory = account.roleAssignments.some((assignment) => mandatoryRoles.has(assignment.role.key));
  const active = account.authCredentials.filter((credential) => !credential.revokedAt && (!credential.expiresAt || credential.expiresAt > now));
  const hasTotp = active.some((credential) => credential.type === "TOTP" && credential.expiresAt == null);
  const hasPasskey = active.some((credential) => credential.type === "PASSKEY");
  const hasRecovery = active.some((credential) => credential.type === "RECOVERY_CODE" && credential.expiresAt == null);
  return {
    mandatory,
    setupRequired: mandatory ? !hasTotp || !hasPasskey : account.mfaRequired && !hasTotp,
    secondFactorRequired: mandatory ? account.mfaRequired || hasTotp || hasRecovery : account.mfaRequired,
  };
}
