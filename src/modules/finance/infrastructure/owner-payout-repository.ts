import { Prisma } from "@prisma/client";
import type { TenantTransaction } from "@/platform/db/tenant";
import type { z } from "zod";
import type { ownerPayoutDraftSchema, OwnerPayoutState } from "../domain/owner-payout";

const include = {
  property: { select: { id: true, name: true, cityId: true, regionId: true, timezone: true, archivedAt: true } },
  owner: { select: { id: true, displayName: true, archivedAt: true } },
  payoutMethod: true,
  approvals: { include: { financialStages: { orderBy: { position: "asc" as const }, include: { recipients: true } } } },
  transaction: { include: { postings: true, reversedByTransactions: true } },
  reversalTransaction: { include: { postings: true } }
} satisfies Prisma.OwnerPayoutInclude;

export type OwnerPayoutRecord = Prisma.OwnerPayoutGetPayload<{ include: typeof include }>;
type TransitionFields = {
  policySnapshot?: Prisma.InputJsonObject;
  methodSnapshotHash?: string;
  eligibleAt?: Date;
  approvedAt?: Date;
  scheduledFor?: Date;
  paidAt?: Date;
  paymentReference?: string;
  transactionId?: string;
  reversalTransactionId?: string;
  reconciledAt?: Date;
  failureReason?: string;
};

export class OwnerPayoutRepository {
  constructor(private readonly tx: TenantTransaction, private readonly organizationId: string) {}

  find(id: string) { return this.tx.ownerPayout.findFirst({ where: { organizationId: this.organizationId, id }, include }); }
  byKey(idempotencyKey: string) { return this.tx.ownerPayout.findUnique({ where: { organizationId_idempotencyKey: { organizationId: this.organizationId, idempotencyKey } }, include }); }
  method(id: string) { return this.tx.ownerPayoutMethod.findFirst({ where: { organizationId: this.organizationId, id } }); }
  property(id:string){return this.tx.property.findFirst({where:{organizationId:this.organizationId,id},select:{id:true,name:true,cityId:true,regionId:true,timezone:true,archivedAt:true}});}
  booking(id:string){return this.tx.reservation.findFirst({where:{organizationId:this.organizationId,id},select:{id:true,reference:true,status:true,createdBy:true,propertyId:true}});}
  reservation(id: string) {
    return this.tx.reservation.findFirst({ where: { organizationId: this.organizationId, id },
      include: { commissionSnapshots: true, reverseReservationFinancialSnapshotreservationIdLink: { orderBy: { version: "asc" } } } });
  }
  bookingCompletion(reservationId: string) {
    return this.tx.reservationRevision.findFirst({ where: { organizationId: this.organizationId, reservationId, operation: "TRANSITION",
      before: { path: ["status"], equals: "FINANCIAL_RECONCILIATION" }, after: { path: ["status"], equals: "CLOSED" } },
      orderBy: { version: "desc" }, select: { id: true, version: true, createdAt: true } });
  }
  async committedAmount(ownerId: string, propertyId: string, currency: string, excludeId: string) {
    const value = await this.tx.ownerPayout.aggregate({ where: { organizationId: this.organizationId, ownerId, propertyId, currency,
      id: { not: excludeId }, state: { in: ["APPROVED", "SCHEDULED"] } }, _sum: { amount: true } });
    return value._sum.amount?.toString() ?? "0";
  }
  page(input:{ownerId:string;propertyId:string;after?:string}){
    return this.tx.ownerPayout.findMany({where:{organizationId:this.organizationId,ownerId:input.ownerId,propertyId:input.propertyId,...(input.after?{id:{lt:input.after}}:{})},
      select:{id:true,ownerId:true,propertyId:true,createdBy:true,state:true,amount:true,currency:true,purpose:true,createdAt:true,paidAt:true,scheduledFor:true,
        property:{select:{cityId:true,regionId:true}},payoutMethod:{select:{label:true}}},orderBy:{id:"desc"},take:51});
  }
  methods(ownerId:string){return this.tx.ownerPayoutMethod.findMany({where:{organizationId:this.organizationId,ownerId,status:"ACTIVE",archivedAt:null},
    select:{id:true,label:true,currency:true},orderBy:[{label:"asc"},{id:"asc"}]});}
  bookings(propertyId:string,query?:string){return this.tx.reservation.findMany({where:{organizationId:this.organizationId,propertyId,archivedAt:null,
    ...(query?{reference:{contains:query,mode:"insensitive"}}:{})},select:{id:true,reference:true,status:true,createdBy:true,propertyId:true},orderBy:[{checkOut:"desc"},{id:"desc"}],take:100});}
  async lock(id: string) { await this.tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${this.organizationId + ":owner-payout:" + id},0))::text`); }
  async lockKey(key: string) { await this.tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${this.organizationId + ":owner-payout-create:" + key},0))::text`); }
  async lockMethod(id:string){await this.tx.$queryRaw(Prisma.sql`SELECT id FROM owner_payout_method WHERE organization_id=${this.organizationId}::uuid AND id=${id}::uuid FOR SHARE`);}
  async lockOwner(ownerId: string, propertyId: string, currency: string) {
    await this.tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${[this.organizationId,"owner-payout-balance",ownerId,propertyId,currency].join(":")},0))::text`);
  }
  audit(id: string, action: string) { return this.tx.auditLog.findFirst({ where: { organizationId: this.organizationId, resourceType: "owner_payout", resourceId: id, action }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] }); }
  create(input: z.infer<typeof ownerPayoutDraftSchema>, actorId: string) {
    return this.tx.ownerPayout.create({ data: { organizationId: this.organizationId, propertyId: input.propertyId, ownerId: input.ownerId,
      reservationId: input.reservationId, payoutMethodId: input.payoutMethodId, fundingAccountId: input.fundingAccountId,
      expectedSettlementAt: input.expectedSettlementAt,
      amount: input.amount, currency: input.currency, purpose: input.purpose, idempotencyKey: input.idempotencyKey,
      createdBy: actorId, updatedBy: actorId }, include });
  }
  transition(id: string, expectedVersion: number, from: OwnerPayoutState, to: OwnerPayoutState, actorId: string,
    fields: TransitionFields = {}) {
    return this.tx.ownerPayout.updateMany({ where: { organizationId: this.organizationId, id, state: from, version: expectedVersion },
      data: { ...fields, state: to, updatedBy: actorId, version: { increment: 1 } } });
  }
}
