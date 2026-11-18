import {mkdir,writeFile} from "node:fs/promises";
import {dirname,resolve,sep} from "node:path";
import {randomUUID} from "node:crypto";
import {PrismaClient} from "@prisma/client";
import {z} from "zod";
import {withTenant} from "@/platform/db/tenant";
import {nativeSupplierPriceFixture} from "../../integration/support/laundry-pricing-fixture";
import {reportOperationIssue} from "@/modules/reservations/application/operation-evidence";
import {createOperationTask} from "@/modules/reservations/application/operation-service";
import {ConfigRuleRepository} from "@/platform/config/config-rule-repository";

const input=z.object({organizationId:z.uuid(),accountId:z.uuid(),personId:z.uuid(),guestLocale:z.enum(["en","fr","ar"]),output:z.string().min(1)}).strict().parse(JSON.parse(process.argv[2]??"null")),target=new URL(process.env.DATABASE_URL??"invalid:");
if(process.env.VERCEL||process.env.VERCEL_ENV||!["127.0.0.1","localhost"].includes(target.hostname)||!(target.pathname.startsWith("/alvillas_automation_")||process.env.GITHUB_ACTIONS==="true"&&target.pathname==="/alvillas_os")||!resolve(input.output).startsWith(resolve(process.cwd())+sep))throw Error("Owned native maintenance browser fixture required");
const db=new PrismaClient();
try{
 const f=await nativeSupplierPriceFixture(db,db,{...input,propertyName:"Original maintenance property "+randomUUID()}),task=await withTenant(db,f.organizationId,tx=>tx.operationTask.findFirstOrThrow({where:{organizationId:f.organizationId,reservationId:f.reservation.id}})),title="Original maintenance observation "+randomUUID(),issueId=await reportOperationIssue({...f.actor,personId:f.person.id},{taskId:task.id,title,description:"Retain the original operational report while managing its independently protected records",severity:"HIGH",idempotencyKey:randomUUID()},f.deps),before=await withTenant(db,f.organizationId,async tx=>({financialCount:await tx.financialTransaction.count({where:{organizationId:f.organizationId}}),stockCount:await tx.inventoryMovement.count({where:{organizationId:f.organizationId}}),original:await tx.operationIssue.findUniqueOrThrow({where:{id:issueId}})}));
 const supplier=await withTenant(db,f.organizationId,async tx=>{await new ConfigRuleRepository(tx,f.organizationId).createVersion({key:"ops.checklists",scopeType:"property",scopeId:f.property.id,createdBy:f.account.id,effectiveFrom:new Date("2020-01-01"),reason:"Owned original maintenance browser checklist",value:{checklists:[{key:"maintenance_original",name:{en:"Maintenance",fr:"Maintenance",ar:"الصيانة"},items:[{key:"evidence",label:{en:"Retain evidence",fr:"Conserver les preuves",ar:"حفظ الأدلة"}}]}]}});return tx.supplier.findUniqueOrThrow({where:{id:f.supplier.id}});});
 await withTenant(db, f.organizationId, async tx => {
   const owner = await tx.owner.create({ data: { organizationId: f.organizationId, displayName: "Original repair owner" } });
   await tx.propertyOwner.create({ data: { organizationId: f.organizationId, propertyId: f.property.id, ownerId: owner.id } });
   const rules = new ConfigRuleRepository(tx, f.organizationId);
   const scope = { scopeType: "property", scopeId: f.property.id, effectiveFrom: new Date("2020-01-01"), createdBy: f.account.id } as const;
   await rules.createVersion({ ...scope, key: "finance.expense_treatment", reason: "Owned browser repair allocation",
     value: { default_treatment: "CUSTOM", categories: { maintenance: { treatment: "CUSTOM", owner_share_bps: 6000, alvillas_share_bps: 4000, guest_share_bps: 0 } } } });
   await rules.createVersion({ ...scope, key: "finance.approval_thresholds", reason: "Owned browser work order estimate approval",
     value: { thresholds: [{ key: "repair_approval", amount: "100.00", currency: "MAD", requires_approval_from: ["finance"] }],
       routing: { finance: { people: [f.person.id], roles: [], assigned: false, channels: ["in_app"] } } } });
 });
 const taskLabel={en:"Maintenance work "+randomUUID(),fr:"Travaux de maintenance "+randomUUID(),ar:"أعمال الصيانة "+randomUUID()},workOrderTask=await createOperationTask({...f.actor,personId:f.person.id},{propertyId:f.property.id,type:"MAINTENANCE",title:taskLabel,dueDate:"2031-05-02",priority:"HIGH",checklistTemplateKey:"maintenance_original",idempotencyKey:randomUUID(),reason:"Use the original Operations task producer for maintenance work"},f.deps);
 await mkdir(dirname(resolve(input.output)),{recursive:true,mode:0o700});
 await writeFile(input.output,JSON.stringify({issueId,taskId:task.id,title,propertyId:f.property.id,propertyLabel:f.property.name,supplierId:f.supplier.id,supplierLabel:supplier.displayName,supplierGrantId:f.grants["supplier:view"],workOrderTaskId:workOrderTask.id,workOrderTitle:taskLabel[input.guestLocale],...before}),{flag:"wx",mode:0o600});
}finally{await db.$disconnect();}
