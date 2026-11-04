import { Prisma } from "@prisma/client";
import type { TenantTransaction } from "@/platform/db/tenant";

export type NativeTaxRate = { taxIndex: number; taxKey: string; configuredValue: unknown };
export type NativeTaxCategory = { key: string; labels: unknown };
export type NativeTaxRule = { taxKey: string; contextIndex: number; categoryKey: string; context: unknown };

/** Native tax read models share the original tenant policy version; they store no copied rate or balance. */
export class TaxHookRepository {
  constructor(private readonly tx: TenantTransaction, private readonly organizationId: string) {}
  async models(policyRuleId: string) {
    const [rates, categories, rules] = await Promise.all([
      this.tx.$queryRaw<NativeTaxRate[]>(Prisma.sql`SELECT tax_index AS "taxIndex",tax_key AS "taxKey",configured_value AS "configuredValue" FROM tax_rate WHERE organization_id=${this.organizationId}::uuid AND policy_rule_id=${policyRuleId}::uuid ORDER BY tax_index`),
      this.tx.$queryRaw<NativeTaxCategory[]>(Prisma.sql`SELECT category_key AS key,labels FROM tax_category WHERE organization_id=${this.organizationId}::uuid AND policy_rule_id=${policyRuleId}::uuid ORDER BY category_key`),
      this.tx.$queryRaw<NativeTaxRule[]>(Prisma.sql`SELECT tax_key AS "taxKey",context_index AS "contextIndex",category_key AS "categoryKey",context FROM tax_rule WHERE organization_id=${this.organizationId}::uuid AND policy_rule_id=${policyRuleId}::uuid ORDER BY tax_index,context_index`)
    ]);
    return { rates, categories, rules };
  }
}
