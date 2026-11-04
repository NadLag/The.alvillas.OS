import {randomUUID} from "node:crypto";
import type {PrismaClient} from "@prisma/client";
import {expect} from "vitest";
import {withTenant} from "@/platform/db/tenant";
import {authContextForAccount} from "@/platform/authz/account-context";
import {ensureStandardIdentitySetup} from "@/modules/identity/application/identity-service";
import {ConfigRuleRepository} from "@/platform/config/config-rule-repository";
import {FinanceRepository} from "@/modules/finance/infrastructure/finance-repository";
import {EmployeeCompensationRepository} from "@/modules/finance/infrastructure/employee-compensation-repository";
import {recordFieldCashInTransaction} from "@/platform/ledger/field-cash-service";
import {cashCollectionRevision} from "@/modules/finance/domain/cash-custody";
import {completeAssignedFieldTask} from "@/modules/reservations/application/reservation-service";

export async function actualServiceFixture(db:PrismaClient,admin:PrismaClient,complete=true,amount="0.07",currency="MAD",minorUnit=2){
 const org=randomUUID();await admin.organization.create({data:{id:org,name:"Actual service collection source",baseCurrency:currency}});await ensureStandardIdentitySetup(org,{db});
 const data=await withTenant(db,org,async tx=>{
  await tx.currency.upsert({where:{code:currency},update:{},create:{code:currency,name:currency,minorUnit}});const person=await tx.person.create({data:{organizationId:org,displayName:"Actual service performer and financial operator"}}),account=await tx.userAccount.create({data:{organizationId:org,personId:person.id}}),role=await tx.role.create({data:{organizationId:org,key:"actual_service_operator",name:"Actual independent financial grants"}}),keys=["task:view","task:edit","cash_collection:view","cash_collection:create","financial_transaction:view","financial_transaction:create"],permissions=await tx.permission.findMany({where:{organizationId:org,key:{in:keys}}});expect(permissions).toHaveLength(keys.length);await tx.rolePermission.createMany({data:permissions.map(permission=>({organizationId:org,roleId:role.id,permissionId:permission.id}))});const grant=await tx.roleAssignment.create({data:{organizationId:org,roleId:role.id,userAccountId:account.id,personId:person.id,scopeType:"organization",validFrom:new Date("2020-01-01")}}),property=await tx.property.create({data:{organizationId:org,name:"Actual service property",addressLine1:"Actual source",city:"Marrakech",timezone:"UTC",propertyType:"VILLA",bedrooms:1,bathrooms:1,maxGuests:2,amenities:[],photoUrls:[]}}),now=await new FinanceRepository(tx,org).clock(),task=await tx.operationTask.create({data:{organizationId:org,propertyId:property.id,assignedToUserAccountId:account.id,assignedToPersonId:person.id,type:"TRANSFER",state:"ASSIGNED",dueDate:now,titleTranslations:{en:"Actual transfer service",fr:"Service de transfert réel"},idempotencyKey:randomUUID(),createdBy:account.id}}),check=await tx.operationTaskChecklistItem.create({data:{organizationId:org,taskId:task.id,key:"actual_service_performed",labelTranslations:{en:"Confirm actual service",fr:"Confirmer le service réalisé"},sortOrder:0}});
  await new ConfigRuleRepository(tx,org).createVersion({key:"finance.accounting_periods",scopeType:"organization",effectiveFrom:new Date("2020-01-01"),createdBy:account.id,value:{timezone:"UTC",allow_early_close:false,max_reopen_seconds:60},reason:"Actual original service source calendar"});return{person,account,role,grant,property,task,check};
 });
 const ctx={organizationId:org,actorId:data.account.id,personId:data.person.id,authContext:{...await authContextForAccount(org,data.account.id,{db}),personId:data.person.id}},receipt=await withTenant(db,org,tx=>recordFieldCashInTransaction(ctx,{taskId:data.task.id,amount,currency,payer:"Actual original service guest",purpose:"Actual original collected service proceeds",expectedRevision:cashCollectionRevision(data.task.id,data.task.version,0n)},{deviceId:randomUUID(),clientOpId:randomUUID(),clientCreatedAt:null},tx,{requestId:randomUUID(),ipAddress:null}));
 if(complete)await completeAssignedFieldTask(ctx,{taskId:data.task.id,checklistItemIds:[data.check.id],idempotencyKey:randomUUID(),note:"Complete actual collected service with original performer evidence"},{db,requestId:randomUUID()});
 const event=await withTenant(db,org,async tx=>(await new EmployeeCompensationRepository(tx,org).completedWork(data.task.id))?.events[0]);return{org,...data,ctx,receipt,input:{collectionId:receipt.id,completionEventId:event?.id??randomUUID()}};
}
