import {Prisma,type CompanyExpenseInvoiceLink} from "@prisma/client";
import type {TenantTransaction,TenantTransactionRunner} from "@/platform/db/tenant";
export class CompanyExpenseInvoiceRepository{
 constructor(readonly tx:TenantTransaction,readonly organizationId:string){}
 runner():TenantTransactionRunner{return{$transaction:async work=>work(this.tx)};}
 async lockSource(invoiceLineId:string){await this.tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${this.organizationId+":company-invoice-source:"+invoiceLineId},0))::text`);}
 line(id:string){return this.tx.supplierInvoiceLine.findFirst({where:{organizationId:this.organizationId,id},include:{revision:{select:{id:true,invoiceId:true,currency:true}}}});}
 current(invoiceLineId:string){return this.tx.companyExpenseInvoiceLink.findFirst({where:{organizationId:this.organizationId,invoiceLineId},orderBy:{version:"desc"}});}
 append(data:Omit<Prisma.CompanyExpenseInvoiceLinkUncheckedCreateInput,"organizationId">){return this.tx.companyExpenseInvoiceLink.create({data:{organizationId:this.organizationId,...data}});}
 async currentMany(ids:readonly string[]){if(!ids.length)return[];return this.tx.$queryRaw<CompanyExpenseInvoiceLink[]>(Prisma.sql`SELECT DISTINCT ON(invoice_line_id) id,organization_id AS "organizationId",invoice_line_id AS "invoiceLineId",company_expense_id AS "companyExpenseId",plan_version AS "planVersion",data_class AS "dataClass",version,state,reason,created_by AS "createdBy",created_at AS "createdAt" FROM company_expense_invoice_link WHERE organization_id=${this.organizationId}::uuid AND invoice_line_id IN(${Prisma.join([...new Set(ids)].map(id=>Prisma.sql`${id}::uuid`))}) ORDER BY invoice_line_id,version DESC`);}
 history(companyExpenseId:string,before?:string){return this.tx.companyExpenseInvoiceLink.findMany({where:{organizationId:this.organizationId,companyExpenseId,...before?{id:{lt:before}}:{}},orderBy:{id:"desc"},take:51,include:{invoiceLine:{include:{revision:{select:{invoiceId:true,invoiceNumber:true}}}}}});}
}
