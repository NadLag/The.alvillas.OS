import { z } from "zod";
import { randomUUID } from "node:crypto";
import defaults from "@/platform/config/defaults/automations.json";
import { automationRuleSchema } from "./rule";
import { AutomationRepository } from "./repository";
import {
  saveAutomationRule,
  AutomationAccessError,
  type AutomationActor,
} from "./service";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { createConfigRuleVersion } from "@/modules/config/application/config-service";
import {
  reservationTaskConfigSchema,
  checklistCatalogSchema,
} from "@/platform/config/rule-registry";
import { withTenant, type TenantTransactionRunner } from "@/platform/db/tenant";
import { prisma } from "@/platform/db/client";
import { authorize } from "@/platform/authz/authorize";

// Installation is an explicit administrator command. It preserves custom values
// and creates drafts; it never turns on financial actions as a side effect.
export async function installAutomationLibrary(
  actor: AutomationActor,
  raw: unknown,
  deps: { db?: TenantTransactionRunner; requestId?: string } = {},
) {
  const input = z
    .object({ propertyId: z.uuid(), reason: z.string().trim().min(6).max(500) })
    .strict()
    .parse(raw);
  return withTenant(deps.db ?? prisma, actor.organizationId, async (tx) => {
    const repo = new AutomationRepository(tx, actor.organizationId),
      p = await repo.property(input.propertyId);
    if (
      !p ||
      actor.authContext.organizationId !== actor.organizationId ||
      actor.authContext.userAccountId !== actor.actorId ||
      !authorize(actor.authContext, "configure", {
        type: "config_rule",
        organizationId: actor.organizationId,
        propertyId: p.id,
        city: p.cityId,
        region: p.regionId,
      })
    )
      throw new AutomationAccessError();
    await repo.lock(`library:${p.id}`);
    const config = new ConfigRuleRepository(tx, actor.organizationId),
      scopes = [
        { scopeType: "property", scopeId: p.id },
        { scopeType: "organization", scopeId: null },
      ];
    for (const [key, initial] of Object.entries(defaults.configuration)) {
      const existing = await config.resolve({ key, scopes }),
        value = existing?.parsedValue;
      let next: unknown = initial;
      if (key === "ops.mid_stay_threshold" && existing) continue;
      if (key === "ops.checklists" && existing) {
        const current = checklistCatalogSchema.parse(value),
          standard = checklistCatalogSchema.parse(initial);
        next = {
          checklists: [
            ...current.checklists,
            ...standard.checklists.filter(
              (c) => !current.checklists.some((v) => v.key === c.key),
            ),
          ],
        };
      }
      if (key === "ops.reservation_task_templates" && existing) {
        const current = reservationTaskConfigSchema.parse(value),
          standard = reservationTaskConfigSchema.parse(initial);
        const tasks = [...current.tasks];
        for (const template of standard.tasks) {
          if (current.tasks.some(existing =>
            (existing.key === template.key && existing.type === template.type) ||
            (existing.type === template.type && existing.due === template.due &&
              (existing.dueOffsetDays ?? 0) === (template.dueOffsetDays ?? 0)))) continue;
          let key = template.key;
          for (let suffix = 1; tasks.some(task => task.key === key); suffix++)
            key = `standard.${template.key}${suffix === 1 ? "" : `.${suffix}`}`;
          tasks.push({ ...template, key });
        }
        next = { tasks };
      }
      if (existing && JSON.stringify(next) === JSON.stringify(value)) continue;
      await createConfigRuleVersion(
        actor,
        {
          key,
          scopeType: "property",
          scopeId: p.id,
          lifecycle: "ACTIVE",
          effectiveFrom: new Date(),
          valueJson: JSON.stringify(next),
          reason: input.reason,
        },
        { db: repo.runner(), requestId: deps.requestId ?? randomUUID() },
      );
    }
    const versions = await repo.versions([p.id]),
      created = [];
    for (const entry of defaults.rules) {
      const key = `standard.${entry.key}`;
      if (
        versions.some(
          (v) => v.key === `automation.rule.${key}` && v.scopeId === p.id,
        )
      )
        continue;
      created.push(
        await saveAutomationRule(
          actor,
          {
            key,
            propertyId: p.id,
            lifecycle: "DRAFT",
            effectiveFrom: new Date(),
            rule: automationRuleSchema.parse(entry.rule),
            reason: input.reason,
          },
          { db: repo.runner(), requestId: deps.requestId ?? randomUUID() },
        ),
      );
    }
    return { created: created.length };
  });
}
export const standardAutomationLibrary = defaults.rules;
