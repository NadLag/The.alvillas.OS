import {randomUUID} from "node:crypto";
import type {PrismaClient} from "@prisma/client";
import {expect} from "vitest";
import {withTenant} from "@/platform/db/tenant";
import {authContextForAccount} from "@/platform/authz/account-context";
import {actualGuestDepositFixture} from "./guest-deposit-fixture";
import {ConfigRuleRepository} from "@/platform/config/config-rule-repository";
import {FinanceRepository} from "@/modules/finance/infrastructure/finance-repository";
import {recordFieldCashInTransaction} from "@/platform/ledger/field-cash-service";
import {cashCollectionRevision} from "@/modules/finance/domain/cash-custody";

export async function actualGuestDepositCashFixture(db:PrismaClient,admin:PrismaClient) {
 const f=await actualGuestDepositFixture(db,admin),task=await withTenant(db,f.org,async tx=>{const permissions=await tx.permission.findMany({where:{organizationId:f.org,key:{in:["cash_collection:pay"]}}});expect(permissions).toHaveLength(1);await tx.rolePermission.createMany({data:permissions.map(permission=>({organizationId:f.org,roleId:f.role.id,permissionId:permission.id}))});await new ConfigRuleRepository(tx,f.org).createVersion({key:"finance.guest_deposits",scopeType:"organization",effectiveFrom:new Date("2020-01-01"),createdBy:f.account.id,value:{...f.policy,cash_admission:{source:"ORIGINAL_FIELD_COLLECTION",limit:"ORIGINAL_UNALLOCATED_CASH",task_types:["ARRIVAL_PREPARATION"],bucket:"GUEST_CASH_ADMISSION"}},reason:"Explicit original booking cash ownership admission policy"});return tx.operationTask.create({data:{organizationId:f.org,propertyId:f.property.id,reservationId:f.reservationId,assignedToUserAccountId:f.account.id,assignedToPersonId:f.person.id,type:"ARRIVAL_PREPARATION",state:"ASSIGNED",dueDate:await new FinanceRepository(tx,f.org).clock(),titleTranslations:{en:"Actual booking cash arrival",fr:"Arrivée avec encaissement réel",ar:"وصول مع تحصيل نقدي فعلي"},idempotencyKey:randomUUID(),createdBy:f.account.id}});});
 const ctx={...f.ctx,authContext:{...await authContextForAccount(f.org,f.account.id,{db}),personId:f.person.id}},cash=await withTenant(db,f.org,tx=>recordFieldCashInTransaction(ctx,{taskId:task.id,amount:"0.07",currency:"MAD",payer:"Original booking guest",purpose:"Actual original guest cash deposit",expectedRevision:cashCollectionRevision(task.id,task.version,0n)},{deviceId:randomUUID(),clientOpId:randomUUID(),clientCreatedAt:null},tx,{requestId:randomUUID(),ipAddress:null}));return{...f,ctx,task,cash};
}
