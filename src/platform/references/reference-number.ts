import { Prisma } from "@prisma/client";
import { assertOrganizationId } from "@/platform/db/tenant";

type ReferenceSequenceRow = {
  value: bigint | number | string;
  width: number;
};

export type ReferenceNumberClient = {
  $queryRaw(query: Prisma.Sql): Promise<ReferenceSequenceRow[]>;
};

const prefixPattern = /^[A-Z][A-Z0-9_]{1,15}$/u;

export function assertReferencePrefix(prefix: string): void {
  if (!prefixPattern.test(prefix)) {
    throw new Error("reference prefix must be uppercase alphanumeric text");
  }
}

export function formatReferenceNumber(prefix: string, value: bigint, width = 4): string {
  assertReferencePrefix(prefix);

  if (value < 1n) {
    throw new Error("reference sequence value must be positive");
  }

  if (!Number.isInteger(width) || width < 1 || width > 12) {
    throw new Error("reference width must be an integer between 1 and 12");
  }

  return `${prefix}-${value.toString().padStart(width, "0")}`;
}

export async function nextReferenceNumber(
  client: ReferenceNumberClient,
  organizationId: string,
  prefix: string,
  width = 4
): Promise<string> {
  assertOrganizationId(organizationId);
  assertReferencePrefix(prefix);

  if (!Number.isInteger(width) || width < 1 || width > 12) {
    throw new Error("reference width must be an integer between 1 and 12");
  }

  const rows = await client.$queryRaw(
    Prisma.sql`
      INSERT INTO reference_sequence (organization_id, prefix, next_value, width)
      VALUES (${organizationId}::uuid, ${prefix}, 2, ${width})
      ON CONFLICT (organization_id, prefix)
      DO UPDATE SET
        next_value = reference_sequence.next_value + 1,
        updated_at = now()
      RETURNING next_value - 1 AS value, width
    `
  );

  const row = rows[0];
  if (!row) {
    throw new Error("reference sequence allocation returned no value");
  }

  return formatReferenceNumber(prefix, BigInt(row.value), row.width);
}
