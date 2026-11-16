import {writeFile} from "node:fs/promises";
import {resolve,sep} from "node:path";
import {randomUUID} from "node:crypto";
import {PrismaClient} from "@prisma/client";
import {z} from "zod";
import {nativeChefMenuFixture} from "../../integration/support/chef-menu-fixture";
import {previewServiceOrder,createServiceOrder} from "@/modules/services/application/service-order-service";
import {previewServiceOrderTransition,transitionServiceOrder} from "@/modules/services/application/service-order-transition";
import {assignOperationTask} from "@/modules/reservations/application/operation-scheduling";
import {withTenant} from "@/platform/db/tenant";
const input=z.object({organizationId:z.uuid(),accountId:z.uuid(),personId:z.uuid(),guestLocale:z.enum(["en","fr","ar"]),output:z.string().min(1)}).strict().parse(JSON.parse(process.argv[2]??"null")),target=new URL(process.env.DATABASE_URL??"invalid:");
if(process.env.VERCEL||process.env.VERCEL_ENV||!["127.0.0.1","localhost"].includes(target.hostname)||!(target.pathname==="/alvillas_automation_chef_menu_20261116"||process.env.GITHUB_ACTIONS==="true"&&target.pathname==="/alvillas_os")||!resolve(input.output).startsWith(resolve(process.cwd())+sep))throw Error("Owned native chef menu browser fixture required");
const db=new PrismaClient();try{
 const f=await nativeChefMenuFixture(db,db,input),review=await previewServiceOrder(f.ctx,f.request,f.deps),order=await createServiceOrder(f.ctx,{request:f.request,reviewFingerprint:review.reviewFingerprint,idempotencyKey:randomUUID()},f.deps),draft={orderId:order.orderId,expectedVersion:1,state:"CONFIRMED",taskPlan:{type:"CHEF",priority:"NORMAL",checklistTemplateKey:"owned_service"},reason:"Confirm actual original native chef browser work"},confirmation=await previewServiceOrderTransition(f.ctx,draft,f.deps);await transitionServiceOrder(f.ctx,{...draft,reviewFingerprint:confirmation.reviewFingerprint,idempotencyKey:randomUUID()},f.deps);
 const saved=await withTenant(db,f.organizationId,async tx=>{const head=await tx.serviceOrder.findFirstOrThrow({where:{organizationId:f.organizationId,id:order.orderId}}),task=await tx.operationTask.findFirstOrThrow({where:{organizationId:f.organizationId,id:head.taskId!}}),empty=await tx.roleAssignment.findFirstOrThrow({where:{organizationId:f.organizationId,userAccountId:f.account.id,role:{key:"e2e_scoped_"+f.account.id}}});return{task,empty};});await assignOperationTask(f.ctx,{taskId:saved.task.id,expectedVersion:saved.task.version,personId:f.chef.id,startMinute:540,idempotencyKey:randomUUID(),reason:"Assign the actual original browser menu chef"},f.deps);
 await writeFile(input.output,JSON.stringify({organizationId:f.organizationId,propertyId:f.property.id,orderId:order.orderId,taskId:saved.task.id,taskViewGrantId:f.grants["task:view"],emptyGrantId:saved.empty.id,menu:f.entry.order_terms.chef_menu}),{flag:"wx",mode:0o600});
}finally{await db.$disconnect();}
