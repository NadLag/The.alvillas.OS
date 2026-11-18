import {randomUUID} from "node:crypto";
import {PrismaClient} from "@prisma/client";
import {it,expect,beforeAll,afterAll,afterEach,vi} from "vitest";
import {withTenant} from "@/platform/db/tenant";
import {authContextForAccount} from "@/platform/authz/account-context";
import {nativeSupplierPriceFixture} from "./support/laundry-pricing-fixture";
import {provisionIntegrationRole} from "./support/database-role";
import {reportOperationIssue} from "@/modules/reservations/application/operation-evidence";
import {previewMaintenanceIssueContext} from "@/modules/maintenance/application/issue-context-service";
import {MaintenanceIssueAccessError,MaintenanceIssueSourceUnavailableError} from "@/modules/maintenance/domain/issue-context";
import {DocumentRepository} from "@/modules/documents/infrastructure/document-repository";
let admin:PrismaClient,db:PrismaClient;
beforeAll(async()=>{
 const url=new URL(process.env.TEST_DATABASE_URL!);if(!["127.0.0.1","localhost"].includes(url.hostname)||!(url.pathname.startsWith("/alvillas_automation_")||process.env.GITHUB_ACTIONS==="true"&&url.pathname==="/alvillas_os"))throw Error("Owned maintenance context database required");
 admin=new PrismaClient({datasourceUrl:url.toString()});await provisionIntegrationRole(admin,"alvillas_ops_tests");url.username=url.password="alvillas_ops_tests";db=new PrismaClient({datasourceUrl:url.toString()});
});
afterEach(()=>vi.restoreAllMocks());afterAll(async()=>{await db?.$disconnect();await admin?.$disconnect();});
async function fixture(){
 const f=await nativeSupplierPriceFixture(admin,db),grants:Record<string,string>={};
 // Global guest records require their own authority; a booking grant alone
 // cannot expose another personal record through a linked operational issue.
 await withTenant(db,f.organizationId,async tx=>{for(const key of["task:view","issue:view","issue:create","team_member:view","guest:view"]){const permission=await tx.permission.findFirstOrThrow({where:{organizationId:f.organizationId,key}}),role=await tx.role.create({data:{organizationId:f.organizationId,key:"maintenance_context_"+randomUUID(),name:"Original maintenance context "+key}});await tx.rolePermission.create({data:{organizationId:f.organizationId,roleId:role.id,permissionId:permission.id}});grants[key]=(await tx.roleAssignment.create({data:{organizationId:f.organizationId,userAccountId:f.account.id,personId:f.person.id,roleId:role.id,scopeType:"organization",validFrom:new Date("2020-01-01")}})).id;}});
 const actor={...f.actor,personId:f.person.id,authContext:{...await authContextForAccount(f.organizationId,f.account.id,{db}),personId:f.person.id}},task=await withTenant(db,f.organizationId,tx=>tx.operationTask.findFirstOrThrow({where:{organizationId:f.organizationId,reservationId:f.reservation.id}})),id=await reportOperationIssue(actor,{taskId:task.id,title:"Original maintenance report",description:"A real maintenance issue reported through the native operational writer",severity:"NORMAL",idempotencyKey:randomUUID()},f.deps);
 return{...f,actor,task,issueId:id,grants:{...f.grants,...grants}};
}
it("reviews original task issues with independent native property, reservation, guest, person and supplier context without financial effects",async()=>{
 const f=await fixture(),sourceIds=[{kind:"PROPERTY",id:f.property.id},{kind:"RESERVATION",id:f.reservation.id},{kind:"GUEST",id:f.reservation.guestId!},{kind:"TASK",id:f.task.id},{kind:"PERSON",id:f.person.id},{kind:"SUPPLIER",id:f.supplier.id}],before=await withTenant(db,f.organizationId,async tx=>({issues:await tx.operationIssue.count({where:{organizationId:f.organizationId}}),money:await tx.financialTransaction.count({where:{organizationId:f.organizationId}}),stock:await tx.inventoryMovement.count({where:{organizationId:f.organizationId}})}));
 const result=await previewMaintenanceIssueContext(f.actor,{issueId:f.issueId,sources:sourceIds},f.deps);expect(result.issue).toMatchObject({id:f.issueId,taskId:f.task.id,propertyId:f.property.id,title:"Original maintenance report"});expect(result.sources.map(source=>source.reference)).toEqual(sourceIds);expect(result.sources.map(source=>source.dataClass)).toEqual(["operational","operational","guest","operational","personal","personal"]);expect(result.reviewFingerprint).toMatch(/^[a-f0-9]{64}$/u);
 expect(await withTenant(db,f.organizationId,async tx=>({issues:await tx.operationIssue.count({where:{organizationId:f.organizationId}}),money:await tx.financialTransaction.count({where:{organizationId:f.organizationId}}),stock:await tx.inventoryMovement.count({where:{organizationId:f.organizationId}})}))).toEqual(before);
 await expect(previewMaintenanceIssueContext(f.actor,{issueId:f.issueId,sources:[{kind:"ASSET",id:randomUUID()}]},f.deps)).rejects.toBeInstanceOf(MaintenanceIssueSourceUnavailableError);
});
it("rejects a source withdrawn during disclosure and foreign native issues before exposing their context",async()=>{
 const f=await fixture(),other=await fixture();await expect(previewMaintenanceIssueContext(f.actor,{issueId:other.issueId,sources:[]},f.deps)).rejects.toBeInstanceOf(MaintenanceIssueAccessError);
 const original=DocumentRepository.prototype.documentSource;let withdrawn=false;
 vi.spyOn(DocumentRepository.prototype,"documentSource").mockImplementation(async function(this:DocumentRepository,...args){const result=await original.apply(this,args);if(!withdrawn&&args[0].kind==="SUPPLIER"){withdrawn=true;await withTenant(db,f.organizationId,tx=>tx.roleAssignment.update({where:{id:f.grants["supplier:view"]},data:{archivedAt:new Date()}}));}return result;});
 await expect(previewMaintenanceIssueContext(f.actor,{issueId:f.issueId,sources:[{kind:"SUPPLIER",id:f.supplier.id}]},f.deps)).rejects.toBeInstanceOf(MaintenanceIssueAccessError);
});
