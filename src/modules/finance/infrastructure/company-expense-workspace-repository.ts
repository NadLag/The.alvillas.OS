import {Prisma} from "@prisma/client";
import {CompanyExpenseRepository} from "./company-expense-repository";

/** Pagination filters the current immutable revision, never a matching historical version. */
export class CompanyExpenseWorkspaceRepository extends CompanyExpenseRepository{
 currencies(){return this.tx.currency.findMany({orderBy:{code:"asc"},select:{code:true,minorUnit:true}});}
 async list(input:{after?:string;query?:string;state?:"PLANNED"|"CANCELLED"},staff:boolean){
  const ids=await this.tx.$queryRaw<Array<{id:string}>>(Prisma.sql`
   WITH current AS(SELECT DISTINCT ON(company_expense_id) company_expense_id,version,purpose,state,data_class
    FROM company_expense_revision WHERE organization_id=${this.organizationId}::uuid ORDER BY company_expense_id,version DESC)
   SELECT company_expense_id AS id FROM current WHERE true
    ${input.after?Prisma.sql`AND company_expense_id<${input.after}::uuid`:Prisma.empty}
    ${input.state?Prisma.sql`AND state=${input.state}`:Prisma.empty}
    ${input.query?Prisma.sql`AND strpos(lower(purpose),lower(${input.query}))>0`:Prisma.empty}
    ${staff?Prisma.empty:Prisma.sql`AND data_class='FINANCIAL'`}
   ORDER BY company_expense_id DESC LIMIT 51`);
  if(!ids.length)return[];
  const plans=await this.tx.companyExpensePlan.findMany({where:{organizationId:this.organizationId,id:{in:ids.map(row=>row.id)}},include:{revisions:{orderBy:{version:"desc"},take:1}}});
  const byId=new Map(plans.map(row=>[row.id,row.revisions[0]]));return ids.map(row=>byId.get(row.id)!);
 }
 async candidates(kind:"INVOICE"|"EMPLOYEE",plan:{currency:string;category:string;costCenter:string},input:{after?:string;query?:string},staff:boolean){
  const table=kind==="INVOICE"?Prisma.sql`supplier_invoice_line`:Prisma.sql`employee_compensation_cost`;
  const links=kind==="INVOICE"?Prisma.sql`company_expense_invoice_link`:Prisma.sql`company_expense_compensation_link`;
  const column=kind==="INVOICE"?Prisma.sql`invoice_line_id`:Prisma.sql`employee_cost_id`;
  const recognized=kind==="INVOICE"?Prisma.sql`EXISTS(SELECT 1 FROM supplier_invoice_recognition_line r WHERE r.organization_id=s.organization_id AND r.invoice_line_id=s.id)`:
   Prisma.sql`EXISTS(SELECT 1 FROM employee_compensation_recognition_line r WHERE r.organization_id=s.organization_id AND r.cost_id=s.id
    AND NOT EXISTS(SELECT 1 FROM financial_transaction opposite WHERE opposite.organization_id=r.organization_id AND opposite.reverses_transaction_id=r.transaction_id))`;
  // Querying labels in the native inspector avoids disclosing a person's name through an unprotected join.
  return this.tx.$queryRaw<Array<{id:string}>>(Prisma.sql`SELECT s.id FROM ${table} s
   LEFT JOIN LATERAL(SELECT state,data_class FROM ${links} l WHERE l.organization_id=s.organization_id AND l.${column}=s.id ORDER BY version DESC LIMIT 1) association ON true
   WHERE s.organization_id=${this.organizationId}::uuid
   AND s.property_id IS NULL AND s.reservation_id IS NULL AND s.currency=${plan.currency} AND s.category=${plan.category} AND s.cost_center=${plan.costCenter}
   AND ${recognized} AND COALESCE(association.state,'RELEASED')<>'ATTACHED'
   ${staff?Prisma.empty:Prisma.sql`AND COALESCE(association.data_class,'FINANCIAL')='FINANCIAL'`}
   ${input.after?Prisma.sql`AND s.id<${input.after}::uuid`:Prisma.empty}
   ORDER BY s.id DESC LIMIT 51`);
 }
 invoices(ids:readonly string[]){return this.tx.supplierInvoiceLine.findMany({where:{organizationId:this.organizationId,id:{in:[...ids]}},include:{revision:{select:{invoiceId:true,invoiceNumber:true}}}});}
 employees(ids:readonly string[]){return this.tx.employeeCompensationCost.findMany({where:{organizationId:this.organizationId,id:{in:[...ids]}},select:{id:true,submissionId:true,claimId:true,amount:true,currency:true,note:true,submission:{select:{runId:true}}}});}
}
