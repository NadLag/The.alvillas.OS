import {Prisma} from "@prisma/client";
import {ServiceAllocationRepository,type ServiceProviderKind} from "./service-allocation-repository";

/** Bounded native source identities; Money and availability are validated by the existing inspectors. */
export class ServiceAllocationWorkspaceRepository extends ServiceAllocationRepository{
 property(id:string){return this.tx.property.findFirst({where:{organizationId:this.organizationId,id},select:{id:true,name:true,cityId:true,regionId:true,archivedAt:true}});}
 collections(input:{propertyId?:string;after?:string}){
  return this.tx.$queryRaw<Array<{id:string;completionEventId:string}>>(Prisma.sql`SELECT c.id,e.id AS "completionEventId" FROM cash_collection c
   JOIN operation_task t ON t.organization_id=c.organization_id AND t.id=c.task_id
   JOIN property p ON p.organization_id=c.organization_id AND p.id=c.property_id
   JOIN financial_transaction journal ON journal.organization_id=c.organization_id AND journal.id=c.transaction_id
   JOIN LATERAL(SELECT id FROM operation_task_event e WHERE e.organization_id=t.organization_id AND e.task_id=t.id AND e.kind='CHANGED' AND e.after->>'state'='COMPLETED' AND e.before->>'state' IS DISTINCT FROM 'COMPLETED' ORDER BY version LIMIT 1) e ON true
   WHERE c.organization_id=${this.organizationId}::uuid AND t.state='COMPLETED' AND t.archived_at IS NULL AND p.archived_at IS NULL AND journal.sealed
   AND NOT EXISTS(SELECT 1 FROM financial_transaction opposite WHERE opposite.organization_id=journal.organization_id AND opposite.reverses_transaction_id=journal.id)
   ${input.propertyId?Prisma.sql`AND c.property_id=${input.propertyId}::uuid`:Prisma.empty}
   ${input.after?Prisma.sql`AND c.id<${input.after}::uuid`:Prisma.empty} ORDER BY c.id DESC LIMIT 51`);
 }
 providers(kind:ServiceProviderKind,scope:{propertyId:string;reservationId:string|null;currency:string},after?:string){
  const table=kind==="SUPPLIER_INVOICE_LINE"?Prisma.sql`supplier_invoice_line`:Prisma.sql`employee_compensation_cost`,column=kind==="SUPPLIER_INVOICE_LINE"?Prisma.sql`supplier_invoice_line_id`:Prisma.sql`employee_cost_id`,recognitions=kind==="SUPPLIER_INVOICE_LINE"?Prisma.sql`supplier_invoice_recognition_line`:Prisma.sql`employee_compensation_recognition_line`,costColumn=kind==="SUPPLIER_INVOICE_LINE"?Prisma.sql`invoice_line_id`:Prisma.sql`cost_id`;
  return this.tx.$queryRaw<Array<{id:string}>>(Prisma.sql`SELECT c.id FROM ${table} c
   WHERE c.organization_id=${this.organizationId}::uuid AND c.currency=${scope.currency} AND c.amount>0
   AND(c.property_id IS NULL OR c.property_id=${scope.propertyId}::uuid) AND(c.reservation_id IS NULL OR c.reservation_id=${scope.reservationId}::uuid)
   AND EXISTS(SELECT 1 FROM ${recognitions} r JOIN financial_transaction journal ON journal.organization_id=r.organization_id AND journal.id=r.transaction_id WHERE r.organization_id=c.organization_id AND r.${costColumn}=c.id AND journal.sealed AND NOT EXISTS(SELECT 1 FROM financial_transaction opposite WHERE opposite.organization_id=journal.organization_id AND opposite.reverses_transaction_id=journal.id))
   AND COALESCE((SELECT state FROM service_allocation_provider_binding b WHERE b.organization_id=c.organization_id AND b.${column}=c.id ORDER BY version DESC LIMIT 1),'RELEASED')<>'ATTACHED'
   ${after?Prisma.sql`AND c.id<${after}::uuid`:Prisma.empty} ORDER BY c.id DESC LIMIT 51`);
 }
 providerLabel(kind:ServiceProviderKind,id:string){
  return kind==="SUPPLIER_INVOICE_LINE"?this.tx.supplierInvoiceLine.findFirst({where:{organizationId:this.organizationId,id},select:{position:true,revision:{select:{invoiceNumber:true}}}}).then(row=>row?[row.revision.invoiceNumber,String(row.position)].join(" · "):null):this.tx.employeeCompensationCost.findFirst({where:{organizationId:this.organizationId,id},select:{note:true,claim:{select:{person:{select:{displayName:true}}}}}}).then(row=>row?[row.claim.person.displayName,row.note].filter(Boolean).join(" · "):null);
 }
}
