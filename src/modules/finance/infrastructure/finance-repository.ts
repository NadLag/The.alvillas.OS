import { Prisma } from "@prisma/client";
import type {
  FinancePostingDraft,
  PropertyOwnerShare
} from "@/modules/finance/domain/reservation-revenue";
import { commissionConfigKey } from "@/modules/finance/domain/reservation-revenue";
import type { TenantTransaction } from "@/platform/db/tenant";

type ReservationWithFinanceContext = Prisma.ReservationGetPayload<{
  include: {
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
  scopeType: string;
  scopeId: string | null;
  value: Prisma.JsonValue;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  version: number;
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

function ownerSharesFromReservation(reservation: ReservationWithFinanceContext): PropertyOwnerShare[] {
  return reservation.property.propertyOwners.map((propertyOwner) => ({
    ownerId: propertyOwner.ownerId,
    ownerName: propertyOwner.owner.displayName,
    shareBps: propertyOwner.shareBps
  }));
}

function specificity(scopeType: string): number {
  switch (scopeType) {
    case "property":
      return 3;
    case "owner":
      return 2;
    case "organization":
      return 1;
    default:
      return 0;
  }
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
      createdAt: reservation.createdAt,
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
    asOf: Date;
  }): Promise<CommissionRuleRow | null> {
    const rules = await this.tx.configRule.findMany({
      where: {
        organizationId: this.organizationId,
        key: commissionConfigKey,
        archivedAt: null,
        effectiveFrom: {
          lte: input.asOf
        },
        OR: [
          {
            effectiveTo: null
          },
          {
            effectiveTo: {
              gt: input.asOf
            }
          }
        ],
        AND: [
          {
            OR: [
              {
                scopeType: "property",
                scopeId: input.propertyId
              },
              {
                scopeType: "owner",
                scopeId: input.ownerId
              },
              {
                scopeType: "organization",
                scopeId: null
              }
            ]
          }
        ]
      },
      select: {
        id: true,
        scopeType: true,
        scopeId: true,
        value: true,
        effectiveFrom: true,
        effectiveTo: true,
        version: true
      }
    });

    return (
      rules.sort((left, right) => {
        const scopeOrder = specificity(right.scopeType) - specificity(left.scopeType);
        if (scopeOrder !== 0) {
          return scopeOrder;
        }

        const effectiveOrder = right.effectiveFrom.getTime() - left.effectiveFrom.getTime();
        if (effectiveOrder !== 0) {
          return effectiveOrder;
        }

        return right.version - left.version;
      })[0] ?? null
    );
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

  async findPostingTransactionsForReservation(reservationId: string): Promise<PostingTransaction[]> {
    const rows = await this.tx.$queryRaw<TransactionIdRow[]>(Prisma.sql`
      SELECT DISTINCT ft.id
      FROM financial_transaction ft
      INNER JOIN posting p
        ON p.transaction_id = ft.id
       AND p.organization_id = ft.organization_id
      WHERE ft.organization_id = ${this.organizationId}::uuid
        AND ft.reverses_transaction_id IS NULL
        AND p.bucket IN ('OWNER_REVENUE', 'COMMISSION')
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
