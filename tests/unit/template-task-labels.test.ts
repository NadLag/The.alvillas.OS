import { describe, expect, it } from "vitest";
import { taskTypeSchema } from "@/platform/config/rule-registry";
import en from "../../messages/en.json";
import fr from "../../messages/fr.json";
import ar from "../../messages/ar.json";

describe("workflow template task labels follow the canonical task catalog", () => {
  for (const [locale, messages] of Object.entries({ en, fr, ar })) it(`labels every selectable task type in ${locale}`, () => {
    const labels: Record<string, string> = messages.Templates.taskTypes;
    for (const type of taskTypeSchema.options) expect(labels[type], `${locale}:${type}`).toBeTypeOf("string");
  });
});
