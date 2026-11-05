import {randomUUID} from "node:crypto";
import type {PrismaClient} from "@prisma/client";
import {expect} from "vitest";
import {withTenant} from "@/platform/db/tenant";
import {authContextForAccount} from "@/platform/authz/account-context";
import {actualGuestDepositFixture} from "./guest-deposit-fixture";
import {createManualReservation} from "@/modules/reservations/application/reservation-service";

export async function actualOtaSettlementFixture(db:PrismaClient,admin:PrismaClient,actual = "0.07") {
  const f = await actualGuestDepositFixture(db, admin), externalId = randomUUID();
  await withTenant(db, f.org, async tx => {
    const keys = ["reservation:view", "financial_transaction:reconcile"], permissions = await tx.permission.findMany({ where: { organizationId: f.org, key: { in: keys } } });
    expect(permissions).toHaveLength(keys.length);
    await tx.rolePermission.createMany({ data: permissions.map(permission => ({ organizationId: f.org, roleId: f.role.id, permissionId: permission.id })) });
  });
  const ctx = { ...f.ctx, authContext: { ...await authContextForAccount(f.org, f.account.id, { db }), personId: f.person.id } };
  const booking = await createManualReservation(ctx, { propertyId: f.property.id, source: "AIRBNB", externalId, guestName: "Actual original OTA guest", guestEmail: "actual-ota@example.test", checkIn: "2031-05-01", checkOut: "2031-05-04", adultCount: 1, childCount: 0, quote: { amount: "0.07", currency: "MAD" }, idempotencyKey: randomUUID() }, { db, requestId: randomUUID() });
  const input = { receivedAccountId: f.banks.receipt.id, idempotencyKey: randomUUID(), csv: "source_reservation_id,source_payout_id,source_transaction_id,currency,gross_amount,platform_fee,expected_payout,actual_receipt,reason,action\n" + `${externalId},actual-payout,${randomUUID()},MAD,0.07,0.00,0.07,${actual},Investigate original OTA source,Review original provider evidence` };
  return { ...f, ctx, booking, input, deps: { db, requestId: randomUUID(), ipAddress: null } };
}
