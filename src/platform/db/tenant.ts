import { Prisma } from "@prisma/client";

export type TenantTransaction = Prisma.TransactionClient;

export type TenantTransactionOptions = {
  maxWait?: number;
  timeout?: number;
  isolationLevel?: Prisma.TransactionIsolationLevel;
};

export type TenantTransactionRunner = {
  $transaction<T>(
    fn: (tx: TenantTransaction) => Promise<T>,
    options?: TenantTransactionOptions
  ): Promise<T>;
};

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function assertOrganizationId(organizationId: string): void {
  if (!uuidPattern.test(organizationId)) {
    throw new Error("organizationId must be a UUID");
  }
}

export async function withTenant<T>(
  db: TenantTransactionRunner,
  organizationId: string,
  work: (tx: TenantTransaction) => Promise<T>,
  options?: TenantTransactionOptions
): Promise<T> {
  assertOrganizationId(organizationId);

  return db.$transaction(async (tx: TenantTransaction) => {
    await tx.$executeRaw(
      Prisma.sql`SELECT set_config('app.current_organization_id', ${organizationId}, true)`
    );

    return work(tx);
  }, options);
}
