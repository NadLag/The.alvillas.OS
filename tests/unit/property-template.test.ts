import { describe, it, expect } from "vitest";
import {
  equalSetting,
  inheritedChanges,
  flattenSettings,
  writeSetting,
  readSetting,
  templateSaveSchema,
  templateChangeSchema
} from "@/modules/core/domain/property-template";
import { checklistCatalogSchema } from "@/platform/config/rule-registry";

const template = (values: unknown, kind = "PROPERTY") => ({
  key: "villa",
  kind,
  name: { en: "Villa", fr: "Villa" },
  values,
  expectedVersion: 0,
  reason: "Standard villa settings"
});
describe("property templates", () => {
  it("validates reusable event-condition-action definitions with the existing workflow schema", () => {
    expect(
      templateSaveSchema.safeParse(
        template(
          {
            rules: {
              "ops.workflows": {
                workflows: [
                  {
                    key: "inspection",
                    trigger: "ReservationConfirmed",
                    conditions: {
                      path: "reservation.nights",
                      op: ">=",
                      value: { config: "ops.mid_stay_threshold" }
                    },
                    actions: [{ type: "create_task", task_type: "INSPECTION" }]
                  }
                ]
              }
            }
          },
          "WORKFLOW"
        )
      ).success
    ).toBe(true);
  });
  it("supports a quoted service without inventing a fixed price", () => {
    expect(
      templateSaveSchema.safeParse(
        template(
          {
            rules: {
              "services.pricing": {
                services: [
                  {
                    key: "chef",
                    name: { en: "Chef on request", fr: "Chef sur demande" },
                    pricing_model: "CUSTOM",
                    available: true
                  }
                ]
              }
            }
          },
          "SERVICE_CATALOG"
        )
      ).success
    ).toBe(true);
  });
  it("keeps omitted property and operating settings absent", () => {
    const parsed = templateSaveSchema.parse(
      template({ property: { bedrooms: 4 }, operating: { chefAvailable: true } })
    );
    expect(parsed.values).toEqual({ property: { bedrooms: 4 }, operating: { chefAvailable: true } });
    expect(
      templateSaveSchema.safeParse(template({ operating: { midStayCleaningRuleKey: "" } })).success
    ).toBe(false);
  });
  it("merges keyed inventory and checklist fields without replacing unrelated entries", () => {
    const values = {
      rules: {
        "inventory.minimums": {
          minimums: [{ item: "towels", quantity: 8, name: { en: "Towels", fr: "Serviettes" } }]
        }
      }
    };
    const target = {
      rules: {
        "inventory.minimums": {
          minimums: [
            { item: "soap", quantity: 3 },
            { item: "towels", quantity: 5, category: "LINEN" }
          ]
        }
      }
    };
    const base = flattenSettings(values);
    for (const [path, value] of Object.entries(base)) writeSetting(target, path, value);
    expect(target.rules["inventory.minimums"].minimums).toEqual([
      { item: "soap", quantity: 3 },
      { item: "towels", quantity: 8, category: "LINEN", name: { en: "Towels", fr: "Serviettes" } }
    ]);
    expect(readSetting(target, "/rules/inventory.minimums/minimums/@item:towels/quantity")).toBe(8);
  });
  it("compares objects independently of key order", () =>
    expect(equalSetting({ en: "A", fr: "B" }, { fr: "B", en: "A" })).toBe(true));
  it("preserves overrides when a template changes a collection between empty and keyed values", () => {
    const path = "/rules/ops.reservation_task_templates/tasks/@key:turnover/checklist";
    const current = {
      rules: {
        "ops.reservation_task_templates": {
          tasks: [
            {
              key: "turnover",
              checklist: [{ key: "custom", label: { en: "Custom", fr: "Personnalisé" } }]
            }
          ]
        }
      }
    };
    expect(
      inheritedChanges(
        current,
        { [path]: [] },
        { [`${path}/@key:linen/label`]: { en: "Linen", fr: "Linge" } }
      )
    ).toEqual({});
  });
  it("distinguishes empty collections from empty objects and accepts workflows with no inline checklist", () => {
    expect(equalSetting([], {})).toBe(false);
    expect(
      templateSaveSchema.safeParse(
        template(
          {
            rules: {
              "ops.reservation_task_templates": {
                tasks: [
                  {
                    key: "turnover",
                    type: "CHECKOUT_CLEANING",
                    title: { en: "Turnover", fr: "Rotation" },
                    due: "CHECK_OUT",
                    checklist: []
                  }
                ]
              }
            }
          },
          "WORKFLOW"
        )
      ).success
    ).toBe(true);
  });
  it("rejects wrong template kind, unknown settings, unsafe keys, invalid money and invalid timezone", () => {
    for (const [values, kind] of [
      [{ property: { name: "Overwrite address" } }, "PROPERTY"],
      [{ property: { bedrooms: 4 } }, "INVENTORY"],
      [{ rules: { "finance.commission": { rate_bps: 2000 } } }, "PROPERTY"],
      [{ property: { timezone: "Invalid/Zone" } }, "PROPERTY"],
      [
        {
          rules: {
            "services.pricing": {
              services: [{ key: "chef", pricing_model: "FIXED", amount: 1.23, currency: "MAD" }]
            }
          }
        },
        "SERVICE_CATALOG"
      ]
    ] as const)
      expect(templateSaveSchema.safeParse(template(values, kind)).success).toBe(false);
    expect(() => writeSetting({}, "/property/__proto__/polluted", true)).toThrow();
    expect(Object.prototype).not.toHaveProperty("polluted");
  });
  it("requires bilingual catalog content and stable unique checklist identities", () => {
    expect(
      checklistCatalogSchema.safeParse({
        checklists: [{ key: "turnover", name: { en: "Turnover" }, items: [] }]
      }).success
    ).toBe(false);
    expect(
      checklistCatalogSchema.safeParse({
        checklists: [
          {
            key: "turnover",
            name: { en: "Turnover", fr: "Rotation" },
            items: [
              { key: "a", label: { en: "A", fr: "A" } },
              { key: "a", label: { en: "B", fr: "B" } }
            ]
          }
        ]
      }).success
    ).toBe(false);
  });
  it("requires a revision, reason and nonempty selected reset values", () => {
    expect(
      templateChangeSchema.safeParse({
        action: "RESET",
        kind: "PROPERTY",
        propertyId: crypto.randomUUID(),
        expectedRevision: 1,
        operationId: crypto.randomUUID(),
        reason: "Reset selected settings",
        paths: []
      }).success
    ).toBe(false);
  });
});
