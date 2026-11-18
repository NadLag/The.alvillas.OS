import {mkdir,writeFile} from "node:fs/promises";
import {dirname,resolve,sep} from "node:path";
import {randomUUID} from "node:crypto";
import {PrismaClient} from "@prisma/client";
import {z} from "zod";
import {withTenant} from "@/platform/db/tenant";
import {nativeSupplierPriceFixture} from "../../integration/support/laundry-pricing-fixture";
import {reportOperationIssue} from "@/modules/reservations/application/operation-evidence";

const input=z.object({organizationId:z.uuid(),accountId:z.uuid(),personId:z.uuid(),guestLocale:z.enum(["en","fr","ar"]),output:z.string().min(1)}).strict().parse(JSON.parse(process.argv[2]??"null")),target=new URL(process.env.DATABASE_URL??"invalid:");
if(process.env.VERCEL||process.env.VERCEL_ENV||!["127.0.0.1","localhost"].includes(target.hostname)||!(target.pathname.startsWith("/alvillas_automation_")||process.env.GITHUB_ACTIONS==="true"&&target.pathname==="/alvillas_os")||!resolve(input.output).startsWith(resolve(process.cwd())+sep))throw Error("Owned native maintenance browser fixture required");
const db=new PrismaClient();
try{
 const f=await nativeSupplierPriceFixture(db,db,{...input,propertyName:"Original maintenance property "+randomUUID()}),task=await withTenant(db,f.organizationId,tx=>tx.operationTask.findFirstOrThrow({where:{organizationId:f.organizationId,reservationId:f.reservation.id}})),title="Original maintenance observation "+randomUUID(),issueId=await reportOperationIssue({...f.actor,personId:f.person.id},{taskId:task.id,title,description:"Retain the original operational report while managing its independently protected records",severity:"HIGH",idempotencyKey:randomUUID()},f.deps),before=await withTenant(db,f.organizationId,async tx=>({financialCount:await tx.financialTransaction.count({where:{organizationId:f.organizationId}}),stockCount:await tx.inventoryMovement.count({where:{organizationId:f.organizationId}}),original:await tx.operationIssue.findUniqueOrThrow({where:{id:issueId}})}));
 const supplier=await withTenant(db,f.organizationId,tx=>tx.supplier.findUniqueOrThrow({where:{id:f.supplier.id}}));
 await mkdir(dirname(resolve(input.output)),{recursive:true,mode:0o700});
 await writeFile(input.output,JSON.stringify({issueId,taskId:task.id,title,propertyId:f.property.id,propertyLabel:f.property.name,supplierId:f.supplier.id,supplierLabel:supplier.displayName,supplierGrantId:f.grants["supplier:view"],...before}),{flag:"wx",mode:0o600});
}finally{await db.$disconnect();}
