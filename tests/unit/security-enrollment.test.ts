import { describe, expect, it } from "vitest";
import { securityEnrollment } from "@/platform/auth/security-enrollment";

const now = new Date("2026-10-14T00:00:00Z");
function account(role: string, types: string[], mfaRequired = false) {
  return { mfaRequired, roleAssignments: [{ role: { key: role } }], authCredentials: types.map((type) => ({ type, expiresAt: null, revokedAt: null })) };
}

describe("mandatory account security enrollment", () => {
  it.each(["admin", "finance"])("restricts %s until passkey and confirmed TOTP are enrolled", (role) => {
    expect(securityEnrollment(account(role, []), now)).toMatchObject({ mandatory: true, setupRequired: true, secondFactorRequired: false });
    expect(securityEnrollment(account(role, ["PASSKEY"]), now).setupRequired).toBe(true);
    expect(securityEnrollment(account(role, ["TOTP"]), now)).toMatchObject({ setupRequired: true, secondFactorRequired: true });
    expect(securityEnrollment(account(role, ["TOTP", "PASSKEY"]), now)).toMatchObject({ setupRequired: false, secondFactorRequired: true });
  });
  it("preserves optional owner MFA and field PIN policy", () => {
    expect(securityEnrollment(account("owner", []), now)).toMatchObject({ mandatory: false, setupRequired: false, secondFactorRequired: false });
    expect(securityEnrollment(account("owner", ["TOTP"], true), now)).toMatchObject({ setupRequired: false, secondFactorRequired: true });
    expect(securityEnrollment(account("field_staff", ["PIN"]), now)).toMatchObject({ mandatory: false, setupRequired: false, secondFactorRequired: false });
  });
  it("does not count unconfirmed, expired or revoked factors", () => {
    const user = account("admin", ["PASSKEY", "TOTP"]);
    expect(securityEnrollment({ ...user, authCredentials: [{ type: "PASSKEY" }, { type: "TOTP", expiresAt: new Date(now.getTime() + 60000) }] }, now).setupRequired).toBe(true);
    expect(securityEnrollment({ ...user, authCredentials: [{ type: "PASSKEY", revokedAt: now }, { type: "TOTP" }] }, now).setupRequired).toBe(true);
    expect(securityEnrollment({ ...user, authCredentials: [{ type: "PASSKEY", expiresAt: now }, { type: "TOTP" }] }, now).setupRequired).toBe(true);
  });
  it("requires MFA after enrollment even when every enrolled factor has been revoked", () => {
    expect(securityEnrollment(account("admin", [], true), now)).toMatchObject({ setupRequired: true, secondFactorRequired: true });
    const user = account("admin", []);
    expect(securityEnrollment({ ...user, authCredentials: [{ type: "RECOVERY_CODE", expiresAt: new Date(now.getTime() + 86400000) }] }, now).secondFactorRequired).toBe(false);
  });
});
