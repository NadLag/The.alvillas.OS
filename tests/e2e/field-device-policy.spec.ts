import { randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { z } from "zod";
import { withTenant } from "@/platform/db/tenant";
import { fieldDevicePolicyKey, fieldDevicePolicySnapshotSchema } from "@/platform/config/field-device-policy";
import { syncPushOpSchema } from "@/modules/reservations/domain/sync-protocol";
import { fieldBrowser, fieldEditorContext } from "./support/field-browser";
import { openFieldFixture } from "./support/field-fixture";
import { fieldNetwork } from "./support/field-network";
import { storedFieldData } from "./support/field-storage";

test.use({ serviceWorkers: "allow", channel: "chromium" });
for (const locale of ["en", "fr", "ar"] as const) test(`Configured queue age remains advisory through offline reload and policy disable in ${locale}`, async ({ browserName }, info) => {
  test.skip(!process.env.DATABASE_URL, "Real PostgreSQL is required for configured queue-age acceptance"); test.setTimeout(180000); expect(browserName).toBe("chromium");
  const native = await fieldBrowser(info), page = native.page;
  await page.clock.install();
  let fixture: Awaited<ReturnType<typeof openFieldFixture>> | undefined, network: Awaited<ReturnType<typeof fieldNetwork>> | undefined,
    editorContext: Awaited<ReturnType<typeof fieldEditorContext>> | undefined;
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  try {
    const f = await openFieldFixture(page, info, locale); fixture = f;
    const jobs = await withTenant(f.db, f.organizationId, async tx => {
      const original = await tx.operationTask.findUniqueOrThrow({ where: { id: f.taskId } });
      await tx.property.create({ data: { organizationId: f.organizationId, name: `Configuration scope property with a deliberately long name ${randomUUID()}`,
        addressLine1: "Test", city: "Marrakech", propertyType: "VILLA", bedrooms: 2, bathrooms: 2, maxGuests: 4, amenities: [], photoUrls: [] } });
      const second = await tx.operationTask.create({ data: { organizationId: f.organizationId, propertyId: original.propertyId,
        assignedToUserAccountId: original.assignedToUserAccountId, assignedToPersonId: original.assignedToPersonId,
        type: "INSPECTION", state: "ASSIGNED", dueDate: original.dueDate, idempotencyKey: randomUUID(),
        titleTranslations: { en: "Another assigned inspection", fr: "Une autre inspection attribuée", ar: "مهمة تفقد أخرى مسندة" },
        checklistItems: { create: { organizationId: f.organizationId, key: "ready", labelTranslations: { en: "Ready", fr: "Prêt", ar: "جاهز" }, sortOrder: 0 } } } });
      return { propertyId: original.propertyId, actorId: original.assignedToUserAccountId!, secondId: second.id };
    });
    network = await fieldNetwork(native.context, "unavailable");
    editorContext = await fieldEditorContext(native.context, info); const editor = await editorContext.newPage();
    const configure = async (minutes: number | null) => {
      await editor.goto(`/${locale}/app/configuration`);
      const form = editor.getByTestId("config-rule-create-form");
      await editor.evaluate(() => document.fonts.ready);
      expect(await editor.evaluate(() => innerWidth)).toBe(editor.viewportSize()!.width);
      expect(await editor.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(await editor.locator(".audience-shell.resource-page").evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      const propertyScope = form.locator('[name="scopeType"][value="property"]');
      try { await propertyScope.check(); } catch (error) {
        const geometry = await propertyScope.evaluate(input => {
          const rect = input.getBoundingClientRect(), hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
          return { rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, scrollX, scrollY,
            documentWidth: document.documentElement.scrollWidth, viewportWidth: innerWidth, viewportHeight: innerHeight, dir: document.documentElement.dir,
            visual: visualViewport ? { offsetLeft: visualViewport.offsetLeft, offsetTop: visualViewport.offsetTop, scale: visualViewport.scale } : null,
            hit: hit ? { tag: hit.tagName, radio: hit.closest("label")?.querySelector('input[type="radio"]')?.getAttribute("value") } : null };
        }).catch(() => ({ unavailable: true }));
        await info.attach("config-scope-hit-target", { body: JSON.stringify(geometry), contentType: "application/json" }); throw error;
      }
      await form.getByTestId("config-rule-scope-id").selectOption(jobs.propertyId);
      await form.getByTestId("config-rule-key").selectOption(fieldDevicePolicyKey); await expect(form.getByTestId("config-rule-key")).toHaveValue(fieldDevicePolicyKey);
      await form.getByTestId("config-rule-lifecycle").selectOption("ACTIVE");
      await form.getByTestId("config-rule-value").fill(JSON.stringify({ queueWarningAfterMinutes: minutes }));
      await form.getByTestId("config-rule-effective-from").fill("2020-01-01T00:00");
      await form.getByTestId("config-rule-reason").fill("Verify the property field queue warning policy");
      expect(await form.evaluate(element => Object.fromEntries(new FormData(element as HTMLFormElement).entries())))
        .toMatchObject({ key: fieldDevicePolicyKey, scopeType: "property", scopeId: jobs.propertyId, lifecycle: "ACTIVE", valueJson: JSON.stringify({ queueWarningAfterMinutes: minutes }) });
      await form.getByTestId("config-rule-submit").click();
      await expect(form.getByTestId("config-rule-form-message")).toHaveAttribute("role", "status");
      return withTenant(f.db, f.organizationId, async tx => {
        const rule = await tx.configRule.findFirstOrThrow({ where: { organizationId: f.organizationId, key: fieldDevicePolicyKey, scopeType: "property", scopeId: jobs.propertyId, lifecycle: "ACTIVE" }, orderBy: { version: "desc" } });
        expect(await tx.auditLog.count({ where: { resourceId: rule.id, actorId: jobs.actorId, action: "config_rule.version.created" } })).toBe(1);
        return rule;
      });
    };
    const enabled = await configure(1);
    const cachedPolicy = async () => z.array(z.object({ task: z.object({ id: z.uuid(), devicePolicy: fieldDevicePolicySnapshotSchema.nullable().optional() }) }))
      .parse(await storedFieldData(page, "jobs")).find(row => row.task.id === f.taskId)?.task.devicePolicy;
    await expect(page.getByTestId("field-sync-now")).toBeEnabled(); await page.getByTestId("field-sync-now").click();
    await expect.poll(cachedPolicy).toEqual({ queueWarningAfterMinutes: 1, configRuleId: enabled.id, configVersion: enabled.version });
    await native.context.setOffline(true); await page.getByTestId("field-checklist-item").check(); await page.getByTestId("field-task-complete").click();
    await expect.poll(() => storedFieldData(page)).toHaveLength(1); const original = await storedFieldData(page);
    const recorded = z.array(z.object({ deviceId: z.uuid(), operation: syncPushOpSchema, devicePolicy: fieldDevicePolicySnapshotSchema })).parse(original)[0];
    expect(recorded.devicePolicy.configRuleId).toBe(enabled.id); expect(recorded.operation.payload.taskId).toBe(f.taskId);
    await expect(page.getByTestId("field-queue-age-warning")).toHaveCount(0);
    const clockGapBefore = await page.evaluate(() => Date.now()) - await editor.evaluate(() => Date.now());
    await page.clock.fastForward(60_001);
    expect(await page.evaluate(() => Date.now()) - await editor.evaluate(() => Date.now()) - clockGapBefore).toBeGreaterThan(55_000);
    await expect(page.getByTestId("field-queue-age-warning")).toBeVisible();
    await page.reload(); await expect(page.getByTestId("field-queue-age-warning")).toBeVisible(); expect(await storedFieldData(page)).toEqual(original);
    await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.goto(`/${locale}/app/field/${jobs.secondId}`); await page.getByTestId("field-checklist-item").check();
    await expect(page.getByTestId("field-task-complete")).toBeEnabled(); await expect(page.getByTestId("field-queue-age-warning")).toBeVisible();
    await native.context.setOffline(false); const disabled = await configure(null);
    await expect(page.getByTestId("field-sync-now")).toBeEnabled(); await page.getByTestId("field-sync-now").click();
    await expect.poll(cachedPolicy).toEqual({ queueWarningAfterMinutes: null, configRuleId: disabled.id, configVersion: disabled.version });
    await expect(page.getByTestId("field-queue-age-warning")).toHaveCount(0); await expect(page.getByTestId("field-checklist-item")).toBeChecked();
    expect(await storedFieldData(page)).toEqual(original);
    await network.release(); await expect(page.getByTestId("field-sync-now")).toBeEnabled(); await page.getByTestId("field-sync-now").click();
    await expect.poll(() => storedFieldData(page)).toEqual([]); await expect(page.getByTestId("field-checklist-item")).toBeChecked();
    await withTenant(f.db, f.organizationId, async tx => {
      const receipt = await tx.syncOp.findMany({ where: { organizationId: f.organizationId, deviceId: recorded.deviceId, clientOpId: recorded.operation.client_op_id } });
      expect(receipt).toHaveLength(1); expect(receipt[0].status).toBe("APPLIED");
      expect(await tx.auditLog.count({ where: { resourceId: f.taskId, action: "task.complete" } })).toBe(1);
      expect(await tx.outboxEvent.count({ where: { type: "TaskCompleted", payload: { path: ["taskId"], equals: f.taskId } } })).toBe(1);
      expect((await tx.operationTask.findUniqueOrThrow({ where: { id: f.taskId } })).completedAt!.getTime()).toBeLessThanOrEqual(Date.now());
      expect((await tx.operationTask.findUniqueOrThrow({ where: { id: jobs.secondId } })).state).toBe("ASSIGNED");
    });
    expect(errors).toEqual([]);
  } finally { await network?.close(); await editorContext?.close(); await fixture?.db.$disconnect(); await native.close(); }
});
