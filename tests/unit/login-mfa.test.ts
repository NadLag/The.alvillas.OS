import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { authenticateMfaChallenge, beginPasswordMfaChallenge, beginVerifiedPasskeyLogin } from "@/platform/auth/identity-auth";
import { decryptSecret, encryptSecret } from "@/platform/auth/secret-encryption";
import { generateTotpSecret, totpCode } from "@/platform/auth/totp";
import { loginRateLimitWasChecked, withCheckedLoginRateLimit } from "@/platform/auth/login-rate-limit";

const mocks = vi.hoisted(() => ({
  findAccount: vi.fn(), updateCredential: vi.fn(), createSession: vi.fn(),
  updateAccount: vi.fn(), upsertDevice: vi.fn(), audit: vi.fn(), verifyPassword: vi.fn(),
  createChallenge: vi.fn(), consumeChallenge: vi.fn()
}));
vi.mock("@/platform/db/client", () => ({ prisma: {} }));
vi.mock("@/platform/db/tenant", () => ({
  withTenant: (_db: unknown, _org: string, callback: (tx: unknown) => unknown) => callback({
    userAccount: { findFirst: mocks.findAccount, update: mocks.updateAccount },
    authCredential: { update: mocks.updateCredential, updateMany: mocks.updateCredential },
    authChallenge: { create: mocks.createChallenge, updateMany: mocks.consumeChallenge },
    $queryRaw: () => Promise.resolve([{ id: "active-account" }]),
    authSession: { create: mocks.createSession }, authDevice: { upsert: mocks.upsertDevice }
  })
}));
vi.mock("@/platform/audit/audit-writer", () => ({ writeAuditEvent: mocks.audit }));
vi.mock("@/platform/auth/password", () => ({ verifyPassword: mocks.verifyPassword }));

function account() {
  const secret = generateTotpSecret();
  return {
    id: randomUUID(), organizationId: randomUUID(), personId: randomUUID(),
    email: "login@example.test", status: "ACTIVE", sessionVersion: 1, mfaRequired: true,
    passwordHash: null, person: { displayName: "Test", preferredLocale: "en" },
    roleAssignments: [{ role: { key: "admin" } }],
    authCredentials: [
      { id: randomUUID(), type: "PASSWORD", secretHash: "password-hash" },
      { id: randomUUID(), type: "TOTP", secretEncrypted: encryptSecret(secret) }
    ], secret
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.verifyPassword.mockImplementation((value: string) => Promise.resolve(value === "valid-password"));
  mocks.createSession.mockResolvedValue({ id: "session-id" });
  mocks.consumeChallenge.mockResolvedValue({ count: 1 });
});

describe("password MFA challenges", () => {
  async function challenge() {
    const user = account();
    mocks.findAccount.mockResolvedValue(user);
    const result = await beginPasswordMfaChallenge({ email: "LOGIN@example.test", password: "valid-password", deviceId: "device-a" });
    expect(result.status).toBe("mfa_required");
    if (result.status !== "mfa_required") throw new Error("Expected MFA challenge");
    return { user, token: result.challengeToken };
  }

  it("does not issue challenges for missing accounts or invalid passwords", async () => {
    mocks.findAccount.mockResolvedValue(null);
    await expect(beginPasswordMfaChallenge({ email: "login@example.test", password: "invalid", deviceId: "device-a" })).resolves.toEqual({ status: "invalid" });
    mocks.findAccount.mockResolvedValue(account());
    await expect(beginPasswordMfaChallenge({ email: "login@example.test", password: "invalid", deviceId: "device-a" })).resolves.toEqual({ status: "invalid" });
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  it("requires a valid second factor before creating an audited session", async () => {
    const { user, token } = await challenge();
    const input = { email: user.email, challengeToken: token, deviceId: "device-a", headers: new Headers() };
    await expect(authenticateMfaChallenge(input)).resolves.toBeNull();
    await expect(authenticateMfaChallenge({ ...input, mfaCode: "invalid" })).resolves.toBeNull();
    expect(mocks.createSession).not.toHaveBeenCalled();
    await expect(authenticateMfaChallenge({ ...input, mfaCode: totpCode(user.secret) })).resolves.toMatchObject({ id: user.id, sessionId: "session-id" });
    expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "identity.account.login", organizationId: user.organizationId }));
  });

  it.each(["tampered", "expired", "wrong-purpose", "wrong-email", "wrong-device", "revoked-session", "inactive-account"])("rejects %s challenges without creating a session", async (reason) => {
    const { user, token } = await challenge();
    let challengeToken = token;
    let email = user.email;
    let deviceId = "device-a";
    if (reason === "tampered") challengeToken = "invalid-envelope";
    if (reason === "expired" || reason === "wrong-purpose") {
      const payload = JSON.parse(decryptSecret(token)) as Record<string, unknown>;
      if (reason === "expired") payload.expiresAt = Date.now() - 1;
      else payload.purpose = "other";
      challengeToken = encryptSecret(JSON.stringify(payload));
    }
    if (reason === "wrong-email") email = "other@example.test";
    if (reason === "wrong-device") deviceId = "device-b";
    if (reason === "revoked-session") mocks.findAccount.mockResolvedValue({ ...user, sessionVersion: 2 });
    if (reason === "inactive-account") mocks.findAccount.mockResolvedValue(null);
    await expect(authenticateMfaChallenge({ email, challengeToken, deviceId, mfaCode: totpCode(user.secret), headers: new Headers() })).resolves.toBeNull();
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  it("rejects already consumed challenges even with a valid second factor", async () => {
    const { user, token } = await challenge();
    mocks.consumeChallenge.mockResolvedValue({ count: 0 });
    await expect(authenticateMfaChallenge({ email: user.email, challengeToken: token, deviceId: "device-a", mfaCode: totpCode(user.secret), headers: new Headers() })).resolves.toBeNull();
    expect(mocks.createSession).not.toHaveBeenCalled();
  });
});

describe("verified passkey session handoff", () => {
  it.each([true, false])("preserves MFA policy when required=%s", async (mfaRequired) => {
    const user = { ...account(), mfaRequired, roleAssignments: [] };
    mocks.findAccount.mockResolvedValue(user);
    const result = await beginVerifiedPasskeyLogin({ email: user.email, userAccountId: user.id, sessionVersion: user.sessionVersion, deviceId: "passkey-device" });
    expect(result.mfaRequired).toBe(mfaRequired);
    const input = { email: user.email, challengeToken: result.challengeToken, deviceId: "passkey-device", headers: new Headers() };
    if (mfaRequired) {
      await expect(authenticateMfaChallenge(input)).resolves.toBeNull();
      expect(mocks.createSession).not.toHaveBeenCalled();
    }
    await expect(authenticateMfaChallenge({ ...input, mfaCode: mfaRequired ? totpCode(user.secret) : undefined })).resolves.toMatchObject({ id: user.id, sessionId: "session-id" });
    expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ after: expect.objectContaining({ method: "passkey" }) as unknown }));
  });

  it("refuses a proof for a different account", async () => {
    mocks.findAccount.mockResolvedValue(account());
    await expect(beginVerifiedPasskeyLogin({ email: "other@example.test", userAccountId: randomUUID(), sessionVersion: 1, deviceId: "device" })).rejects.toThrow();
    expect(mocks.createChallenge).not.toHaveBeenCalled();
  });
  it("refuses a proof captured before credential or session revocation", async () => {
    const user = { ...account(), sessionVersion: 2 };
    mocks.findAccount.mockResolvedValue(user);
    await expect(beginVerifiedPasskeyLogin({ email: user.email, userAccountId: user.id, sessionVersion: 1, deviceId: "device" })).rejects.toThrow();
    expect(mocks.createChallenge).not.toHaveBeenCalled();
  });
});

describe("server-only login rate-limit context", () => {
  it("defaults to unchecked and binds the check to the account and IP", async () => {
    expect(loginRateLimitWasChecked("login@example.test", "127.0.0.1")).toBe(false);
    await withCheckedLoginRateLimit("login@example.test", "127.0.0.1", async () => {
      await Promise.resolve();
      expect(loginRateLimitWasChecked("login@example.test", "127.0.0.1")).toBe(true);
      expect(loginRateLimitWasChecked("other@example.test", "127.0.0.1")).toBe(false);
      expect(loginRateLimitWasChecked("login@example.test", "other-ip")).toBe(false);
    });
    expect(loginRateLimitWasChecked("login@example.test", "127.0.0.1")).toBe(false);
  });

  it("isolates concurrent requests", async () => {
    await Promise.all(["account-a", "account-b"].map((key) =>
      withCheckedLoginRateLimit(key, "127.0.0.1", async () => {
        await Promise.resolve();
        expect(loginRateLimitWasChecked(key, "127.0.0.1")).toBe(true);
        expect(loginRateLimitWasChecked(key === "account-a" ? "account-b" : "account-a", "127.0.0.1")).toBe(false);
      })
    ));
  });
});
