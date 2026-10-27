import { ReservationConfigScopeRepository } from "@/platform/config/reservation-scope-repository";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import type {
  FinancePostingDraft,
  PropertyOwnerShare
} from "@/modules/finance/domain/reservation-revenue";
import { commissionConfigKey } from "@/modules/finance/domain/reservation-revenue";
import { ConfigRuleRepository, configRuleSnapshotMetadata } from "@/platform/config/config-rule-repository";
import { referencedConfigs } from "@/platform/automation/rule";
import type { TenantTransaction } from "@/platform/db/tenant";
import { paymentAccountCode, paymentAccountKinds } from "../domain/payment-account";

type ReservationWithFinanceContext = Prisma.ReservationGetPayload<{
  include: {
    commissionSnapshots: true;
    reverseReservationFinancialSnapshotreservationIdLink: true;
    property: {
      include: {
        propertyOwners: {
          include: {
            owner: true;
          };
        };
      };
    };
  };
}>;

export type FinanceLedgerAccount = {
  id: string;
  code: string;
  name: string;
  accountType: string;
  normalSide: string;
  archivedAt: Date | null;
};

export type CommissionRuleRow = {
  id: string;
  key: string;
  scopeType: string;
  scopeId: string | null;
  value: Prisma.JsonValue;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  version: number;
  lifecycle: "DRAFT" | "ACTIVE" | "RETIRED";
};

export type PostingTransaction = Prisma.FinancialTransactionGetPayload<{
  include: {
    postings: true;
    reversedByTransactions: true;
  };
}>;

type TransactionIdRow = {
  id: string;
};

type ActiveRevenueRow = {
  reservationId: string;
};

type SettlementVarianceRow = {
  id: string;
  settlementId: string;
  reservationId: string | null;
  reservationReference: string | null;
  propertyId: string | null;
  propertyName: string | null;
  sourceReservationId: string | null;
  sourcePayoutId: string | null;
  sourceTransactionId: string | null;
  expectedAmount: string;
  actualAmount: string;
  varianceAmount: string;
  currency: string;
  reason: string;
  action: string;
  status: string;
  createdAt: Date;
};

function ownerSharesFromReservation(reservation: ReservationWithFinanceContext): PropertyOwnerShare[] {
  for (const snapshot of reservation.reverseReservationFinancialSnapshotreservationIdLink) {
    const envelope = z.object({ owners: z.array(z.object({ ownerId: z.uuid(), ownerName: z.string(), shareBps: z.number().int() })) }).safeParse(snapshot.rules);
    if (envelope.success) return envelope.data.owners;
  }
  if (reservation.commissionSnapshots.length) return reservation.commissionSnapshots.map(snapshot => {
    const value = snapshot.snapshotValue;
    const ownerName = value && typeof value === "object" && !Array.isArray(value) && typeof value.owner_name === "string" ? value.owner_name : snapshot.ownerId;
    return { ownerId: snapshot.ownerId, ownerName, shareBps: snapshot.shareBps };
  });
  return reservation.property.propertyOwners.map((propertyOwner) => ({
    ownerId: propertyOwner.ownerId,
    ownerName: propertyOwner.owner.displayName,
    shareBps: propertyOwner.shareBps
  }));
}

function inputJsonObject(value: Record<string, unknown>): Prisma.InputJsonObject {
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, Prisma.InputJsonValue] => {
      const [, entryValue] = entry;
      return entryValue !== undefined;
    })
  );
}

export class FinanceRepository {
  constructor(
    private readonly tx: TenantTransaction,
    private readonly organizationId: string
  ) {}

  async lockPaymentAccount(key: string): Promise<Date> {
    await this.tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${this.organizationId + ":payment-account:" + key},0))::text`);
    return this.clock();
  }

  async clock(): Promise<Date> {
    const [clock] = await this.tx.$queryRaw<Array<{ now: Date }>>(Prisma.sql`SELECT clock_timestamp() AS now`);
    return clock.now;
  }

  async lockReservationFinancialCorrection(reservationId: string): Promise<Date> {
    await this.tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${this.organizationId + ":reservation-financial-correction:" + reservationId},0))::text`);
    return this.clock();
  }

  financialReversalAudit(action: string, resourceType: string, resourceIds: string[]) {
    return this.tx.auditLog.findFirst({ where: { organizationId: this.organizationId, action, resourceType,
      resourceId: { in: resourceIds } }, orderBy: { createdAt: "asc" } });
  }

  paymentAccountsByKey(idempotencyKey: string) {
    return this.tx.ledgerAccount.findMany({ where: { organizationId: this.organizationId,
      code: { in: paymentAccountKinds.map(kind => paymentAccountCode({ kind, idempotencyKey })) } }, take: 2 });
  }

  ledgerAccountCreationAudit(id: string) {
    return this.tx.auditLog.findFirst({ where: { organizationId: this.organizationId,
      resourceType: "ledger_account", resourceId: id, action: "finance.account.created" }, orderBy: { createdAt: "asc" } });
  }

  listLedgerAccounts(input: { after?: string; query?: string; take: number }) {
    return this.tx.ledgerAccount.findMany({ where: { organizationId: this.organizationId,
      ...(input.after ? { id: { gt: input.after } } : {}),
      ...(input.query ? { OR: [ { name: { contains: input.query, mode: "insensitive" as const } }, { code: { contains: input.query, mode: "insensitive" as const } } ] } : {}) },
      orderBy: { id: "asc" }, take: input.take,
      select: { id: true, code: true, name: true, accountType: true, normalSide: true, archivedAt: true } });
  }

  async findOrganizationBaseCurrency(): Promise<string> {
    const organization = await this.tx.organization.findUniqueOrThrow({
      where: { id: this.organizationId },
      select: { baseCurrency: true }
    });

    return organization.baseCurrency;
  }

  async findReservation(reservationId: string): Promise<{
    id: string;
    reference: string;
    source: string;
    propertyId: string;
    propertyName: string;
    createdAt: Date;
    owners: PropertyOwnerShare[];
  } | null> {
    const reservation = await this.tx.reservation.findFirst({
      where: {
        id: reservationId,
        organizationId: this.organizationId,
        archivedAt: null
      },
      include: {
        commissionSnapshots: { where: { organizationId: this.organizationId }, orderBy: { ownerId: "asc" } },
        reverseReservationFinancialSnapshotreservationIdLink: { where: { organizationId: this.organizationId, rules: { path: ["owners"], array_contains: [] } }, orderBy: { version: "asc" }, take: 1 },
        property: {
          include: {
            propertyOwners: {
              where: {
                archivedAt: null,
                owner: {
                  archivedAt: null
                }
              },
              include: {
                owner: true
              },
              orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }]
            }
          }
        }
      }
    });

    if (!reservation || reservation.property.archivedAt) {
      return null;
    }

    return {
      id: reservation.id,
      reference: reservation.reference,
      source: reservation.source,
      propertyId: reservation.propertyId,
      propertyName: reservation.property.name,
      createdAt: reservation.confirmedAt ?? reservation.createdAt,
      owners: ownerSharesFromReservation(reservation)
    };
  }

  async findLedgerAccountById(accountId: string): Promise<FinanceLedgerAccount | null> {
    return this.tx.ledgerAccount.findFirst({
      where: {
        id: accountId,
        organizationId: this.organizationId
      },
      select: {
        id: true,
        code: true,
        name: true,
        accountType: true,
        normalSide: true,
        archivedAt: true
      }
    });
  }

  async findAirbnbReservationBySourceIdentifier(sourceReservationId: string): Promise<{
    id: string;
    reference: string;
    source: string;
    externalId: string | null;
    propertyId: string;
    propertyName: string;
  } | null> {
    const reservation = await this.tx.reservation.findFirst({
      where: {
        organizationId: this.organizationId,
        source: "AIRBNB",
        archivedAt: null,
        OR: [
          {
            externalId: sourceReservationId
          },
          {
            reference: sourceReservationId
          }
        ]
      },
      include: {
        property: true
      }
    });

    if (!reservation || reservation.property.archivedAt) {
      return null;
    }

    return {
      id: reservation.id,
      reference: reservation.reference,
      source: reservation.source,
      externalId: reservation.externalId,
      propertyId: reservation.propertyId,
      propertyName: reservation.property.name
    };
  }

  async listRevenuePostingAccounts(): Promise<Array<{ id: string; name: string; code: string }>> {
    return this.tx.ledgerAccount.findMany({
      where: {
        organizationId: this.organizationId,
        accountType: "ASSET_LOCATION",
        normalSide: "DEBIT",
        archivedAt: null
      },
      orderBy: [{ name: "asc" }, { code: "asc" }],
      select: {
        id: true,
        name: true,
        code: true
      },
      take: 100
    });
  }

  async ensureLedgerAccount(input: {
    code: string;
    name: string;
    accountType: string;
    normalSide: "DEBIT" | "CREDIT";
  }): Promise<FinanceLedgerAccount> {
    await this.tx.ledgerAccount.createMany({
      data: {
        organizationId: this.organizationId,
        code: input.code,
        name: input.name,
        accountType: input.accountType,
        normalSide: input.normalSide
      },
      skipDuplicates: true
    });

    return this.tx.ledgerAccount.findUniqueOrThrow({
      where: {
        organizationId_code: {
          organizationId: this.organizationId,
          code: input.code
        }
      },
      select: {
        id: true,
        code: true,
        name: true,
        accountType: true,
        normalSide: true,
        archivedAt: true
      }
    });
  }

  async resolveCommissionRule(input: {
    propertyId: string;
    ownerId: string;
    source?: string;
    asOf: Date;
  }): Promise<CommissionRuleRow | null> {
    const rule = await new ConfigRuleRepository(this.tx, this.organizationId).resolve({
      key: commissionConfigKey,
      asOf: input.asOf,
      scopes: await new ReservationConfigScopeRepository(this.tx, this.organizationId).scopes(input)
    });

    return rule
      ? {
          id: rule.id,
          key: rule.key,
          scopeType: rule.scopeType,
          scopeId: rule.scopeId,
          value: rule.value,
          effectiveFrom: rule.effectiveFrom,
          effectiveTo: rule.effectiveTo,
          version: rule.version,
          lifecycle: rule.lifecycle
        }
      : null;
  }

  async findCommissionSnapshot(input: {
    reservationId: string;
    ownerId: string;
  }) {
    return this.tx.commissionSnapshot.findUnique({
      where: {
        organizationId_reservationId_ownerId: {
          organizationId: this.organizationId,
          reservationId: input.reservationId,
          ownerId: input.ownerId
        }
      }
    });
  }
  async captureExpensePolicy(input: { propertyId: string; ownerId: string; source?: string; asOf: Date; inlineApproval?: unknown }) {
    const repository = new ConfigRuleRepository(this.tx, this.organizationId);
    const scopes = await new ReservationConfigScopeRepository(this.tx, this.organizationId).scopes(input), snapshot = await repository.scopedSnapshot(scopes, input.asOf);
    const allocation = snapshot.resolve("finance.expense_allocation") ?? snapshot.resolve("finance.expense_treatment"), approval = snapshot.resolve("finance.approval_thresholds");
    const serialize = (rule: NonNullable<typeof allocation>) => ({ ...configRuleSnapshotMetadata(rule), value: rule.parsedValue });
    const references = [], missingReferences: string[] = [];
    for (const key of referencedConfigs(input.inlineApproval ?? approval?.parsedValue ?? {})) {
      const rule = snapshot.resolve(key); if (rule) references.push(serialize(rule)); else missingReferences.push(key);
    }
    return inputJsonObject({ allocation: allocation ? serialize(allocation) : null, approval: approval ? serialize(approval) : null, references, missingReferences });
  }

  async createCommissionSnapshot(input: {
    reservationId: string;
    propertyId: string;
    ownerId: string;
    configRuleId: string;
    shareBps: number;
    commissionRateBps: number;
    commissionBasis: string;
    accrualEvent: string;
    snapshotValue: Prisma.InputJsonObject;
    createdBy: string;
  }) {
    return this.tx.commissionSnapshot.create({
      data: {
        organizationId: this.organizationId,
        reservationId: input.reservationId,
        propertyId: input.propertyId,
        ownerId: input.ownerId,
        configRuleId: input.configRuleId,
        shareBps: input.shareBps,
        commissionRateBps: input.commissionRateBps,
        commissionBasis: input.commissionBasis,
        accrualEvent: input.accrualEvent,
        snapshotValue: input.snapshotValue,
        createdBy: input.createdBy
      }
    });
  }

  async findTransactionsByIdempotencyKeys(idempotencyKeys: readonly string[]): Promise<PostingTransaction[]> {
    if (idempotencyKeys.length === 0) {
      return [];
    }

    return this.tx.financialTransaction.findMany({
      where: {
        organizationId: this.organizationId,
        idempotencyKey: {
          in: [...idempotencyKeys]
        }
      },
      include: {
        postings: true,
        reversedByTransactions: true
      }
    });
  }

  async findAirbnbSettlementBySourceTransactionId(sourceTransactionId: string) {
    return this.tx.airbnbSettlement.findUnique({
      where: {
        organizationId_sourceTransactionId: {
          organizationId: this.organizationId,
          sourceTransactionId
        }
      }
    });
  }

  async findAirbnbSettlement(settlementId: string) {
    return this.tx.airbnbSettlement.findFirst({
      where: {
        id: settlementId,
        organizationId: this.organizationId
      },
      include: {
        reservation: true,
        property: true
      }
    });
  }

  async createAirbnbSettlement(input: {
    reservationId: string;
    propertyId: string;
    sourceReservationId: string;
    sourcePayoutId: string;
    sourceTransactionId: string;
    currency: string;
    grossAmount: string;
    platformFee: string;
    expectedPayout: string;
    actualReceipt: string;
    idempotencyKey: string;
    importedBy: string;
  }) {
    return this.tx.airbnbSettlement.create({
      data: {
        organizationId: this.organizationId,
        reservationId: input.reservationId,
        propertyId: input.propertyId,
        sourceReservationId: input.sourceReservationId,
        sourcePayoutId: input.sourcePayoutId,
        sourceTransactionId: input.sourceTransactionId,
        currency: input.currency,
        grossAmount: input.grossAmount,
        platformFee: input.platformFee,
        expectedPayout: input.expectedPayout,
        actualReceipt: input.actualReceipt,
        idempotencyKey: input.idempotencyKey,
        importedBy: input.importedBy
      }
    });
  }

  async createVariance(input: {
    sourceType: string;
    sourceId: string;
    propertyId: string;
    reservationId: string;
    expectedAmount: string;
    actualAmount: string;
    varianceAmount: string;
    currency: string;
    reason: string;
    action: string;
    createdBy: string;
  }) {
    return this.tx.variance.create({
      data: {
        organizationId: this.organizationId,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        propertyId: input.propertyId,
        reservationId: input.reservationId,
        expectedAmount: input.expectedAmount,
        actualAmount: input.actualAmount,
        varianceAmount: input.varianceAmount,
        currency: input.currency,
        reason: input.reason,
        action: input.action,
        createdBy: input.createdBy
      }
    });
  }

  async listOpenAirbnbSettlementVariances(): Promise<SettlementVarianceRow[]> {
    return this.tx.$queryRaw<SettlementVarianceRow[]>(Prisma.sql`
      SELECT
        v.id,
        v.source_id AS "settlementId",
        v.reservation_id AS "reservationId",
        r.reference AS "reservationReference",
        v.property_id AS "propertyId",
        p.name AS "propertyName",
        s.source_reservation_id AS "sourceReservationId",
        s.source_payout_id AS "sourcePayoutId",
        s.source_transaction_id AS "sourceTransactionId",
        v.expected_amount::text AS "expectedAmount",
        v.actual_amount::text AS "actualAmount",
        v.variance_amount::text AS "varianceAmount",
        v.currency,
        v.reason,
        v.action,
        v.status,
        v.created_at AS "createdAt"
      FROM variance v
      LEFT JOIN airbnb_settlement s
        ON s.id = v.source_id
       AND s.organization_id = v.organization_id
      LEFT JOIN reservation r
        ON r.id = v.reservation_id
       AND r.organization_id = v.organization_id
      LEFT JOIN property p
        ON p.id = v.property_id
       AND p.organization_id = v.organization_id
      WHERE v.organization_id = ${this.organizationId}::uuid
        AND v.source_type = 'AIRBNB_SETTLEMENT'
        AND v.status = 'OPEN'
      ORDER BY v.created_at DESC
      LIMIT 100
    `);
  }

  async findPostingTransactionsForAirbnbSettlement(settlementId: string): Promise<PostingTransaction[]> {
    const rows = await this.tx.$queryRaw<TransactionIdRow[]>(Prisma.sql`
      SELECT DISTINCT ft.id
      FROM financial_transaction ft
      INNER JOIN posting p
        ON p.transaction_id = ft.id
       AND p.organization_id = ft.organization_id
      WHERE ft.organization_id = ${this.organizationId}::uuid
        AND ft.reverses_transaction_id IS NULL
        AND p.dimensions @> jsonb_build_object('airbnb_settlement_id', ${settlementId})
      ORDER BY ft.id ASC
    `);
    const ids = rows.map((row) => row.id);

    if (ids.length === 0) {
      return [];
    }

    const transactions = await this.tx.financialTransaction.findMany({
      where: {
        organizationId: this.organizationId,
        id: {
          in: ids
        }
      },
      include: {
        postings: true,
        reversedByTransactions: true
      }
    });
    const byId = new Map(transactions.map((transaction) => [transaction.id, transaction]));

    return ids.flatMap((id) => {
      const transaction = byId.get(id);
      return transaction ? [transaction] : [];
    });
  }

  async findPostingTransactionsForReservation(reservationId: string, includeSettlements = false): Promise<PostingTransaction[]> {
    const rows = await this.tx.$queryRaw<TransactionIdRow[]>(Prisma.sql`
      SELECT DISTINCT ft.id
      FROM financial_transaction ft
      INNER JOIN posting p
        ON p.transaction_id = ft.id
       AND p.organization_id = ft.organization_id
      WHERE ft.organization_id = ${this.organizationId}::uuid
        AND ft.reverses_transaction_id IS NULL
        AND (p.bucket IN ('OWNER_REVENUE', 'COMMISSION') OR (${includeSettlements} AND p.dimensions ? 'airbnb_settlement_id'))
        AND p.dimensions @> jsonb_build_object('reservation_id', ${reservationId})
      ORDER BY ft.id ASC
    `);
    const ids = rows.map((row) => row.id);

    if (ids.length === 0) {
      return [];
    }

    const transactions = await this.tx.financialTransaction.findMany({
      where: {
        organizationId: this.organizationId,
        id: {
          in: ids
        }
      },
      include: {
        postings: true,
        reversedByTransactions: true
      }
    });
    const byId = new Map(transactions.map((transaction) => [transaction.id, transaction]));

    return ids.flatMap((id) => {
      const transaction = byId.get(id);
      return transaction ? [transaction] : [];
    });
  }

  async listActiveRevenueReservationIds(): Promise<string[]> {
    const rows = await this.tx.$queryRaw<ActiveRevenueRow[]>(Prisma.sql`
      SELECT DISTINCT p.dimensions->>'reservation_id' AS "reservationId"
      FROM posting p
      INNER JOIN financial_transaction ft
        ON ft.id = p.transaction_id
       AND ft.organization_id = p.organization_id
      WHERE p.organization_id = ${this.organizationId}::uuid
        AND p.bucket = 'OWNER_REVENUE'
        AND p.dimensions ? 'reservation_id'
        AND ft.reverses_transaction_id IS NULL
        AND NOT EXISTS (
          SELECT 1
          FROM financial_transaction reversal
          WHERE reversal.organization_id = ft.organization_id
            AND reversal.reverses_transaction_id = ft.id
        )
    `);

    return rows.map((row) => row.reservationId);
  }

  async createFinancialTransaction(input: {
    reference: string;
    occurredAt: Date;
    description: string;
    idempotencyKey: string;
    reversesTransactionId?: string;
    createdBy: string;
    postings: readonly FinancePostingDraft[];
  }): Promise<PostingTransaction> {
    return this.tx.financialTransaction.create({
      data: {
        organizationId: this.organizationId,
        reference: input.reference,
        occurredAt: input.occurredAt,
        description: input.description,
        reversesTransactionId: input.reversesTransactionId,
        idempotencyKey: input.idempotencyKey,
        createdBy: input.createdBy,
        postings: {
          create: input.postings.map((posting) => ({
            organizationId: this.organizationId,
            ledgerAccountId: posting.ledgerAccountId,
            side: posting.side,
            amount: posting.amount.toJSON().amount,
            currency: posting.amount.currency,
            bucket: posting.bucket,
            dimensions: inputJsonObject(posting.dimensions)
          }))
        }
      },
      include: {
        postings: true,
        reversedByTransactions: true
      }
    });
  }
}
