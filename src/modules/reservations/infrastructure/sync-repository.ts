import { Prisma } from "@prisma/client";
import type { SyncOpStatus } from "@/modules/reservations/domain/sync-protocol";
import type { TenantTransaction } from "@/platform/db/tenant";

type JsonObject = Record<string, unknown>;

function toInputJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function toJsonObject(value: Prisma.JsonValue | null): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

export type SyncOpRecord = {
  id: string;
  clientOpId: string;
  status: SyncOpStatus | "PENDING";
  result: JsonObject | null;
  errorCode: string | null;
  actorUserAccountId: string | null;
  type: string;
  payload: Prisma.JsonValue;
};

export class SyncRepository {
  constructor(
    private readonly tx: TenantTransaction,
    private readonly organizationId: string
  ) {}

  async lockDevice(deviceId: string): Promise<void> {
    await this.tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`sync:${this.organizationId}:${deviceId}`}, 0))`);
  }

  async lockActor(personId: string): Promise<void> {
    // Task lifecycle triggers lock the performer row. Take that lock before an
    // INSERT's foreign-key KEY SHARE lock can obstruct a concurrent completion.
    await this.tx.$queryRaw(Prisma.sql`SELECT id FROM person WHERE organization_id = ${this.organizationId}::uuid AND id = ${personId}::uuid FOR UPDATE`);
  }

  async findByClientOp(deviceId: string, clientOpId: string): Promise<SyncOpRecord | null> {
    const op = await this.tx.syncOp.findUnique({
      where: {
        organizationId_deviceId_clientOpId: {
          organizationId: this.organizationId,
          deviceId,
          clientOpId
        }
      }
    });

    if (!op) {
      return null;
    }

    return {
      id: op.id,
      clientOpId: op.clientOpId,
      status: op.status as SyncOpRecord["status"],
      result: toJsonObject(op.result),
      errorCode: op.errorCode,
      actorUserAccountId: op.actorUserAccountId,
      type: op.type,
      payload: op.payload
    };
  }

  async createPending(input: {
    deviceId: string;
    clientOpId: string;
    type: string;
    payload: unknown;
    actorUserAccountId: string;
    actorPersonId: string;
    clientCreatedAt: Date | null;
  }): Promise<void> {
    await this.tx.syncOp.create({
      data: {
        organizationId: this.organizationId,
        deviceId: input.deviceId,
        clientOpId: input.clientOpId,
        type: input.type,
        status: "PENDING",
        payload: toInputJson(input.payload),
        actorUserAccountId: input.actorUserAccountId,
        actorPersonId: input.actorPersonId,
        clientCreatedAt: input.clientCreatedAt
      }
    });
  }

  async finish(
    deviceId: string,
    clientOpId: string,
    status: SyncOpStatus,
    result: JsonObject,
    errorCode: string | null
  ): Promise<void> {
    await this.tx.syncOp.update({
      where: {
        organizationId_deviceId_clientOpId: {
          organizationId: this.organizationId,
          deviceId,
          clientOpId
        }
      },
      data: {
        status,
        result: toInputJson(result),
        errorCode,
        appliedAt: new Date()
      }
    });
  }
}
