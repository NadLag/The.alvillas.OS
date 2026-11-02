import { Prisma, type CompanyExpenseCompensationLink } from "@prisma/client";
import type { TenantTransaction, TenantTransactionRunner } from "@/platform/db/tenant";

export class CompanyExpenseCompensationRepository {
  constructor(readonly tx: TenantTransaction, readonly organizationId: string) {}
  runner(): TenantTransactionRunner { return { $transaction: async work => work(this.tx) }; }
  async lockSource(employeeCostId: string) {
    await this.tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${this.organizationId + ":company-compensation-source:" + employeeCostId},0))::text`);
  }
  cost(id: string) {
    return this.tx.employeeCompensationCost.findFirst({ where: { organizationId: this.organizationId, id }, include: { submission: { select: { runId: true } } } });
  }
  current(employeeCostId: string) {
    return this.tx.companyExpenseCompensationLink.findFirst({ where: { organizationId: this.organizationId, employeeCostId }, orderBy: { version: "desc" } });
  }
  append(data: Omit<Prisma.CompanyExpenseCompensationLinkUncheckedCreateInput, "organizationId">) {
    return this.tx.companyExpenseCompensationLink.create({ data: { organizationId: this.organizationId, ...data } });
  }
  async currentMany(ids: readonly string[]) {
    if (!ids.length) return [];
    return this.tx.$queryRaw<CompanyExpenseCompensationLink[]>(Prisma.sql`SELECT DISTINCT ON(employee_cost_id)
      id,organization_id AS "organizationId",employee_cost_id AS "employeeCostId",company_expense_id AS "companyExpenseId",
      plan_version AS "planVersion",data_class AS "dataClass",version,state,reason,created_by AS "createdBy",created_at AS "createdAt"
      FROM company_expense_compensation_link WHERE organization_id=${this.organizationId}::uuid
        AND employee_cost_id IN(${Prisma.join([...new Set(ids)].map(id => Prisma.sql`${id}::uuid`))})
      ORDER BY employee_cost_id,version DESC`);
  }
  history(companyExpenseId: string, before?: string) {
    return this.tx.companyExpenseCompensationLink.findMany({ where: { organizationId: this.organizationId, companyExpenseId, ...(before ? { id: { lt: before } } : {}) },
      orderBy: { id: "desc" }, take: 51, include: { employeeCost: { include: { submission: { select: { runId: true } } } } } });
  }
}
