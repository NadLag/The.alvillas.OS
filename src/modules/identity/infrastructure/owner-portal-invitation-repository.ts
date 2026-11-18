import { Prisma } from "@prisma/client";
import type { TenantTransaction } from "@/platform/db/tenant";

export class OwnerPortalInvitationRepository {
  constructor(private readonly tx: TenantTransaction, private readonly organizationId: string) {}

  async representative(ownerId: string, email: string) {
    const rows = await this.tx.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT representative.id
      FROM owner_representative representative
      JOIN owner ON owner.organization_id = representative.organization_id AND owner.id = representative.owner_id
      WHERE representative.organization_id = ${this.organizationId}::uuid AND representative.owner_id = ${ownerId}::uuid
        AND lower(representative.email) = ${email} AND representative.status = 'ACTIVE'
        AND representative.archived_at IS NULL AND owner.archived_at IS NULL
        AND (representative.valid_from IS NULL OR representative.valid_from <= statement_timestamp())
        AND (representative.valid_to IS NULL OR representative.valid_to > statement_timestamp())
      ORDER BY representative.id
      LIMIT 2 FOR SHARE OF representative, owner`);
    return rows.length === 1 ? rows[0] : null;
  }

  async owner(ownerId: string, email: string) {
    const [owner] = await this.tx.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT id FROM owner
      WHERE organization_id = ${this.organizationId}::uuid AND id = ${ownerId}::uuid
        AND archived_at IS NULL AND lower(email) = ${email}
      FOR SHARE`);
    return owner ?? null;
  }

  async activate(input: {
    ownerId: string;
    accountId: string;
    representativeId: string | null;
    assignmentId: string;
    actorId: string | null;
  }) {
    const [grant] = await this.tx.$queryRaw<{ id: string }[]>(Prisma.sql`
      INSERT INTO owner_portal_access (organization_id, owner_id, user_account_id, representative_id, role_assignment_id, created_by)
      VALUES (${this.organizationId}::uuid, ${input.ownerId}::uuid, ${input.accountId}::uuid,
        ${input.representativeId}::uuid, ${input.assignmentId}::uuid, ${input.actorId}::uuid)
      RETURNING id`);
    return grant;
  }
}
