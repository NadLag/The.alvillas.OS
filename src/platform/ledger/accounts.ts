import { FinanceRepository } from "@/modules/finance/infrastructure/finance-repository";
import type { TenantTransaction } from "@/platform/db/tenant";

// Public boundary for modules that attach an existing finance ledger account.
export function ensureLedgerAccount(
  tx: TenantTransaction,
  organizationId: string,
  input: Parameters<FinanceRepository["ensureLedgerAccount"]>[0]
) {
  return new FinanceRepository(tx, organizationId).ensureLedgerAccount(input);
}
