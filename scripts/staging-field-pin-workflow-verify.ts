import { randomInt, randomUUID, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { chromium, expect as playwrightExpect, type BrowserContext } from "@playwright/test";
import { z } from "zod";
import AxeBuilder from "@axe-core/playwright";
import { PrismaClient, type Prisma } from "@prisma/client";
import { calendarDateAt } from "@/i18n/format";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { ReservationConfigScopeRepository } from "@/platform/config/reservation-scope-repository";
import { operationPolicySchema } from "@/platform/config/operation-policy";
import { checklistCatalogSchema, taskTypeSchema } from "@/platform/config/rule-registry";
import { verifyPassword } from "@/platform/auth/password";
import { fieldPullResultSchema } from "@/modules/reservations/domain/field-pull";
import { PinSecurityRepository } from "@/modules/identity/infrastructure/pin-security-repository";
import { pinLockoutState } from "@/modules/identity/domain/pin-lockout";
import { propertyMinute } from "@/modules/reservations/domain/operation-task";

// Native staging mutations are restricted to this explicitly authorized test
// account/task. Database access is read only; PINs exist only in process memory.
const expect = playwrightExpect.configure({ timeout: 30000 });
const origin = "https://the-alvillas-os-staging.vercel.app";
const privateRoot = realpathSync(join(process.env.USERPROFILE ?? "", ".alvillas-os/secrets"));
const sha = process.env.STAGING_EXPECTED_SHA ?? "";
if (!/^[a-f0-9]{40}$/u.test(sha)) throw new Error("Exact staging SHA is required");
const evidenceFile = join(privateRoot, "staging-field-pin-workflow.private.json");
const fieldState = join(privateRoot, "staging-field-pin-user.storage-state.json");
if (existsSync(evidenceFile)) throw new Error("Existing PIN workflow checkpoint requires read-only recovery; do not repeat native mutations");
if (dirname(fieldState) !== privateRoot) throw new Error("Private field state directory required");
const databaseUrl = readFileSync(join(privateRoot, "staging-app-role-database-url.txt"), "utf8").trim();
const database = new URL(databaseUrl);
const identity = createHash("sha256").update(database.hostname.replace("-pooler", "") + database.pathname).digest("hex");
if (identity !== execFileSync("gh", ["variable", "get", "STAGING_DATABASE_IDENTITY", "--env", "staging"], { encoding: "utf8" }).trim()) throw new Error("Verified staging database identity required");
const db = new PrismaClient({ datasourceUrl: databaseUrl });
const browser = await chromium.launch();
const admin = await browser.newContext({ baseURL: origin, storageState: join(privateRoot, "staging-automation.storage-state.json") });
const worker = await browser.newContext({ baseURL: origin, viewport: { width: 360, height: 900 } });
for (const context of [admin, worker]) { context.setDefaultTimeout(30000); context.setDefaultNavigationTimeout(90000); }
const administrator = await admin.newPage(), employee = await worker.newPage();
let phase = "preflight";
const evidence: Record<string, unknown> = { sha, origin, completed: false, accountKind: "dedicated-staging-test", pinPersisted: false, checks: [] };
const checkpoint = () => writeFileSync(evidenceFile, JSON.stringify({ ...evidence, phase }, null, 2));
let organizationId = "";
const sessionId = z.union([z.uuid(), z.literal("")]);
const sessionSchema = z.object({ user: z.object({ id: sessionId, personId: sessionId, organizationId: sessionId, sessionId,
  securitySetupRequired: z.boolean().optional(), sessionRevoked: z.boolean().optional() }).optional() }).nullable();
const session = async (context: BrowserContext) => sessionSchema.parse(await (await context.request.get("/api/auth/session")).json());
async function authenticatedSession(context: BrowserContext) {
  const user = (await session(context))?.user;
  if (!user?.id) throw new Error("Verified authenticated staging session required");
  return user;
}
async function read<T>(callback: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return db.$transaction(async tx => {
    await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
    await tx.$executeRawUnsafe("SELECT set_config('app.current_organization_id',$1,true)", organizationId);
    const roles = await tx.$queryRaw<Array<{ rolsuper: boolean; rolbypassrls: boolean }>>`SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user`;
    expect(roles).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    return callback(tx);
  }, { timeout: 60000, maxWait: 10000 });
}
async function layouts(path: (locale: string) => string, testId: string, kind: string) {
  for (const locale of ["en", "fr", "ar"]) for (const width of [1440, 360]) {
    await employee.setViewportSize({ width, height: 900 }); await employee.goto(path(locale));
    await expect(employee.getByTestId(testId)).toBeVisible();
    await expect(employee.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
    expect((await new AxeBuilder({ page: employee }).analyze()).violations).toEqual([]);
    expect(await employee.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await employee.keyboard.press("Tab"); expect(await employee.evaluate(() => document.activeElement !== document.body)).toBe(true);
    (evidence.checks as unknown[]).push({ kind, locale, width, keyboard: true, axeViolations: 0 });
  }
}
try {
  expect(await (await admin.request.get("/api/version")).json()).toMatchObject({ version: sha, environment: "preview", commitRef: "main" });
  const actor = await authenticatedSession(admin);
  expect(actor?.id).toBeTruthy(); expect(actor.securitySetupRequired).toBe(false); expect(actor.sessionRevoked).not.toBe(true);
  organizationId = actor.organizationId; evidence.organizationId = organizationId; evidence.administratorId = actor.id;
  const seed = await read(async tx => {
    const property = await tx.property.findFirstOrThrow({ where: { organizationId, name: "Automation acceptance aut-5859f142", archivedAt: null } });
    const scopes = await new ReservationConfigScopeRepository(tx, organizationId).scopes({ propertyId: property.id, asOf: new Date() });
    const config = new ConfigRuleRepository(tx, organizationId);
    const policy = operationPolicySchema.parse((await config.resolve({ key: "ops.task_policy", scopes }))?.parsedValue);
    const checklists = checklistCatalogSchema.parse((await config.resolve({ key: "ops.checklists", scopes }))?.parsedValue);
    const type = taskTypeSchema.options.find(type => policy.types[type]?.role_keys.includes("field_staff"));
    if (!type || !checklists.checklists.length) throw new Error("Existing configured field-staff task and checklist are required");
    // NANPA reserves 555-0100..0199 as non-working fictional numbers. No email
    // is provided; the existing manual-phone invitation sends no SMS or email.
    const phones = Array.from({ length: 100 }, (_, index) => `+120255501${String(index).padStart(2, "0")}`);
    const used = await tx.person.findMany({ where: { organizationId, phone: { in: phones } }, select: { phone: true } });
    const phone = phones.find(phone => !used.some(row => row.phone === phone));
    if (!phone) throw new Error("Unused dedicated fictional test number required");
    const other = await tx.operationTask.findFirstOrThrow({ where: { organizationId, propertyId: property.id, assignedToUserAccountId: actor.id, archivedAt: null }, select: { id: true } });
    return { property, phone, type, template: checklists.checklists[0].key, startMinute: policy.types[type].start_minute ?? policy.shift_start_minute, otherTaskId: other.id };
  });
  const name = `Field PIN acceptance pin-${randomUUID().slice(0, 8)}`;
  const scheduled = new Date(Date.now() + 60 * 60 * 1000);
  const pin = `00${randomInt(1000, 10000)}`, newPin = `01${randomInt(1000, 10000)}`;
  evidence.displayName = name; evidence.phone = seed.phone; evidence.propertyId = seed.property.id; evidence.otherTaskId = seed.otherTaskId;
  phase = "create-dedicated-task";
  await administrator.goto(`/en/app/operations/new?propertyId=${seed.property.id}`);
  const create = administrator.getByTestId("operation-create-form"); await expect(create).toBeVisible();
  await create.locator('[name="type"]').selectOption(seed.type);
  for (const key of ["titleEn", "titleFr"]) await create.locator(`[name="${key}"]`).fill(name);
  await create.locator('[name="dueDate"]').fill(calendarDateAt(scheduled, seed.property.timezone));
  await create.locator('[name="checklistTemplateKey"]').selectOption(seed.template);
  await create.locator('[name="reason"]').fill("Dedicated staging Phone and PIN workflow acceptance; no operational work");
  evidence.createKey = await create.locator('[name="idempotencyKey"]').inputValue(); evidence.createSubmitted = true; checkpoint();
  await create.locator('button[type="submit"]').click(); await expect(administrator).toHaveURL(/\/en\/app\/operations\/[a-f0-9-]{36}$/u);
  const taskId = new URL(administrator.url()).pathname.split("/").at(-1)!; evidence.taskId = taskId; checkpoint();
  phase = "invite-dedicated-employee";
  await administrator.goto("/en/app/identity"); await expect(administrator.getByTestId("identity-page")).toBeVisible();
  await administrator.getByTestId("invite-display-name").fill(name); await administrator.getByTestId("invite-phone").fill(seed.phone);
  await administrator.getByTestId("invite-role").selectOption("field_staff");
  await administrator.getByTestId("invite-scope-type").selectOption("job"); await administrator.getByTestId("invite-scope-id").fill(taskId);
  await administrator.locator('[name="expiresInHours"]').fill("1"); evidence.invitationSubmitted = true; checkpoint();
  await administrator.getByTestId("invite-submit").click(); await expect(administrator.getByTestId("invitation-code")).toBeVisible();
  const code = (await administrator.getByTestId("invitation-code").innerText()).split(":").at(-1)!.trim();
  expect(code.length).toBeGreaterThan(10);
  phase = "employee-chooses-own-pin";
  await layouts(locale => `/${locale}/activate/${code}`, "activation-pin", "activation");
  await employee.goto(`/en/activate/${code}`); await expect(employee.getByTestId("activation-pin")).toHaveAttribute("type", "password");
  await employee.getByTestId("activation-phone").fill(seed.phone); await employee.getByTestId("activation-pin").fill(pin);
  expect(await employee.getByTestId("activation-password").inputValue()).toBe(""); evidence.activationSubmitted = true; checkpoint();
  await employee.getByTestId("activation-submit").click(); await expect(employee).toHaveURL(/\/en\/login$/u);
  const account = await read(async tx => {
    const account = await tx.userAccount.findFirstOrThrow({ where: { organizationId, phone: seed.phone }, include: { authCredentials: true } });
    const credentials = account.authCredentials.filter(row => row.type === "PIN" && !row.revokedAt);
    expect(credentials).toHaveLength(1); expect(credentials[0].secretHash?.startsWith("$argon2id$")).toBe(true);
    expect(await verifyPassword(pin, credentials[0].secretHash!)).toBe(true);
    expect(account.passwordHash).toBeNull(); expect(account.authCredentials.some(row => row.type === "PASSWORD")).toBe(false);
    return { id: account.id, personId: account.personId, sessionVersion: account.sessionVersion };
  });
  evidence.actorId = account.id; evidence.personId = account.personId; evidence.pinHashVerified = true; evidence.passwordCredentialAbsent = true; checkpoint();
  phase = "single-use-invitation";
  await employee.goto(`/en/activate/${code}`); await employee.getByTestId("activation-phone").fill(seed.phone); await employee.getByTestId("activation-pin").fill(pin);
  await employee.getByTestId("activation-submit").click(); await expect(employee.getByTestId("identity-form-error")).toBeVisible();
  evidence.invitationReplayDenied = true; checkpoint();
  phase = "independent-phone-pin-login";
  await layouts(locale => `/${locale}/login?surface=field`, "login-pin-keypad", "login");
  const login = async (value: string, success: boolean) => {
    await employee.goto("/en/login?surface=field"); await expect(employee.locator('input[name="method"][value="pin"]')).toBeChecked();
    await employee.getByTestId("login-phone").fill(seed.phone);
    await expect(employee.getByTestId("login-pin")).toHaveAttribute("type", "password");
    await employee.getByTestId("login-pin").fill(value); await employee.getByTestId("login-submit").click();
    if (success) { await expect(employee).toHaveURL(/\/en\/app\/field$/u); await expect(employee.getByTestId("field-page")).toBeVisible(); }
    else { await expect(employee.getByTestId("login-error")).toBeVisible(); expect((await session(worker))?.user?.id).toBeFalsy(); }
  };
  await login(pin, true);
  const firstSession = await authenticatedSession(worker);
  expect(firstSession.id).toBe(account.id); expect(firstSession.id).not.toBe(actor.id); expect(firstSession.organizationId).toBe(organizationId);
  phase = "scoped-native-assignment";
  await administrator.goto(`/en/app/operations/${taskId}`);
  const assignment = administrator.getByTestId("operation-assign-form"); await expect(assignment).toBeVisible();
  await assignment.locator('[name="personId"]').selectOption(account.personId);
  const startMinute = propertyMinute(scheduled, seed.property.timezone);
  await assignment.locator('[name="startTime"]').fill(`${Math.floor(startMinute / 60).toString().padStart(2, "0")}:${(startMinute % 60).toString().padStart(2, "0")}`);
  await assignment.locator('[name="reason"]').fill("Assign only the dedicated Phone and PIN acceptance job to its test employee");
  evidence.assignmentKey = await assignment.locator('[name="idempotencyKey"]').inputValue(); evidence.assignmentSubmitted = true; checkpoint();
  await assignment.locator('button[type="submit"]').click(); await expect(assignment.getByRole("status")).toBeVisible();
  const params = new URLSearchParams({ organization_id: organizationId, actor_user_id: account.id, mode: "assigned" });
  const pull = fieldPullResultSchema.parse(await (await worker.request.get(`/api/sync/pull?${params}`)).json());
  expect(pull.tasks.map(row => row.id)).toEqual([taskId]);
  for (const row of pull.tasks) for (const key of ["guestName", "guestEmail", "guestPhone", "financialSnapshot", "balance", "commission"]) expect(row).not.toHaveProperty(key);
  expect((await worker.request.get(`/en/app/field/${seed.otherTaskId}`)).status()).toBe(404);
  params.set("actor_user_id", actor.id); expect((await worker.request.get(`/api/sync/pull?${params}`)).status()).toBe(403);
  params.set("actor_user_id", account.id); params.set("organization_id", randomUUID()); expect((await worker.request.get(`/api/sync/pull?${params}`)).status()).toBe(403);
  await layouts(locale => `/${locale}/app/field/${taskId}`, "field-task-page", "assigned-task");
  evidence.assignedOnly = true; evidence.forgedActorDenied = true; evidence.foreignTenantDenied = true; checkpoint();
  phase = "authorized-masked-pin-reset";
  await administrator.goto("/en/app/identity"); const row = administrator.getByTestId("identity-account-row").filter({ hasText: name }); await expect(row).toHaveCount(1);
  await expect(row.getByTestId("reset-pin-input")).toHaveAttribute("type", "password"); await row.getByTestId("reset-pin-input").fill(newPin);
  evidence.resetSubmitted = true; checkpoint(); await row.getByTestId("reset-pin-button").click(); await expect(row.locator(".pin-reset-form")).toContainText("PIN reset");
  expect((await session(worker))?.user?.id).toBeFalsy();
  expect((await worker.request.get(`/api/sync/pull?${new URLSearchParams({ organization_id: organizationId, actor_user_id: account.id, mode: "assigned" })}`)).status()).toBe(401);
  phase = "old-pin-denied-and-new-pin-accepted";
  await login(pin, false);
  const delay = await read(async tx => { const repository = new PinSecurityRepository(tx, organizationId); const now = new Date(); return pinLockoutState(await repository.state(seed.phone), await repository.policy(now), now); });
  if (delay.locked) { const remaining = delay.lockedUntil.getTime() - Date.now(); if (remaining > 60000) throw new Error("Configured PIN backoff remains active; preserve checkpoint"); await employee.waitForTimeout(Math.max(0, remaining) + 200); }
  await login(newPin, true); await worker.storageState({ path: fieldState });
  const secondSession = await authenticatedSession(worker);
  expect(secondSession.id).toBe(account.id); expect(secondSession.sessionId).not.toBe(firstSession.sessionId);
  phase = "read-only-data-and-audit-proof";
  evidence.dataProof = await read(async tx => {
    const credentials = await tx.authCredential.findMany({ where: { organizationId, userAccountId: account.id } });
    const active = credentials.filter(row => row.type === "PIN" && !row.revokedAt), old = credentials.filter(row => row.type === "PIN" && row.revokedAt);
    expect(active).toHaveLength(1); expect(old).toHaveLength(1); expect(active[0].secretHash?.startsWith("$argon2id$")).toBe(true);
    expect(await verifyPassword(newPin, active[0].secretHash!)).toBe(true); expect(await verifyPassword(pin, active[0].secretHash!)).toBe(false);
    const current = await tx.userAccount.findUniqueOrThrow({ where: { id: account.id } }); expect(current.sessionVersion).toBe(account.sessionVersion + 1);
    const sessions = await tx.authSession.findMany({ where: { organizationId, userAccountId: account.id } });
    expect(sessions.filter(row => row.revokedAt)).toHaveLength(1); expect(sessions.filter(row => !row.revokedAt)).toHaveLength(1);
    const audits = await tx.auditLog.findMany({ where: { organizationId, resourceId: account.id } });
    expect(audits.filter(row => row.action === "identity.invitation.accept")).toHaveLength(1);
    expect(audits.filter(row => row.action === "identity.pin.reset" && row.actorId === actor.id)).toHaveLength(1);
    expect(audits.filter(row => row.action === "identity.account.login" && (row.after as { method?: string })?.method === "pin")).toHaveLength(2);
    for (const value of [pin, newPin]) expect(JSON.stringify(audits).includes(JSON.stringify(value))).toBe(false);
    const grants = await tx.roleAssignment.findMany({ where: { organizationId, userAccountId: account.id, archivedAt: null }, include: { role: { include: { rolePermissions: { include: { permission: true } } } } } });
    expect(grants).toHaveLength(1); expect(grants[0]).toMatchObject({ scopeType: "job", scopeId: taskId });
    expect(grants[0].role.rolePermissions.map(row => row.permission.key).sort()).toEqual(["task:edit", "task:view"]);
    const task = await tx.operationTask.findUniqueOrThrow({ where: { id: taskId } }); expect(task).toMatchObject({ state: "ASSIGNED", assignedToUserAccountId: account.id, assignedToPersonId: account.personId });
    expect(await tx.operationTask.count({ where: { organizationId: { not: organizationId } } })).toBe(0);
    return { nonBypassRuntimeRole: true, foreignTenantRows: 0, nativePinLoginAudits: 2, invitationAcceptAudits: 1, resetAudits: 1, activePinCredentials: 1, revokedPinCredentials: 1, oldSessionRevoked: true, sessionVersionIncremented: true, permissions: ["task:edit", "task:view"], scope: "single-job", financialAccess: false, pinHashesVerified: true, plaintextPinsInAudit: false };
  });
  expect(await (await admin.request.get("/api/version")).json()).toMatchObject({ version: sha, environment: "preview", commitRef: "main" });
  evidence.completed = true; evidence.authenticatedPinAcceptance = true; evidence.privateStateSaved = true; phase = "complete"; checkpoint();
  console.log(JSON.stringify({ sha, pinWorkflow: "accepted", nativePinLogins: 2, oldPinDenied: true, resetSessionRevoked: true, assignedOnly: true, layouts: (evidence.checks as unknown[]).length, pinPersisted: false }));
} catch {
  checkpoint(); throw new Error(`Native PIN workflow incomplete at ${phase}; preserve private checkpoint and do not repeat mutations`);
} finally { await browser.close(); await db.$disconnect(); }
