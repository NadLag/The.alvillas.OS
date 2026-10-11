import { Prisma } from "@prisma/client";
import type {
  ManualReservationInput,
  OperationTaskSummary,
  ReservationSummary,
  ReservationTaskConfig,
  ReservationTaskTemplate
} from "@/modules/reservations/domain/reservation-task";
import {
  dateToUtc,
  nightsBetween,
  reservationTaskConfigSchema
} from "@/modules/reservations/domain/reservation-task";
import type { TenantTransaction } from "@/platform/db/tenant";

type ReservationWithProperty = Prisma.ReservationGetPayload<{
  include: {
    property: true;
    _count: {
      select: {
        conflicts: true;
      };
    };
  };
}>;

type TaskWithRelations = Prisma.OperationTaskGetPayload<{
  include: {
    property: true;
    reservation: true;
  };
}>;

type ConfigRuleRow = {
  value: Prisma.JsonValue;
};

function toStringRecord(value: Prisma.JsonValue): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  );
}

function taskTitleJson(template: ReservationTaskTemplate): Prisma.InputJsonObject {
  return Object.fromEntries(
    Object.entries(template.title).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string"
    )
  );
}

function reservationToSummary(reservation: ReservationWithProperty): ReservationSummary {
  return {
    id: reservation.id,
    reference: reservation.reference,
    propertyId: reservation.propertyId,
    propertyName: reservation.property.name,
    guestName: reservation.guestName,
    source: reservation.source as ReservationSummary["source"],
    status: reservation.status,
    checkIn: reservation.checkIn,
    checkOut: reservation.checkOut,
    nights: reservation.nights,
    conflictCount: reservation._count.conflicts,
    createdAt: reservation.createdAt
  };
}

function taskToSummary(task: TaskWithRelations): OperationTaskSummary {
  return {
    id: task.id,
    propertyName: task.property.name,
    reservationReference: task.reservation?.reference ?? null,
    guestName: task.reservation?.guestName ?? null,
    type: task.type as OperationTaskSummary["type"],
    state: task.state,
    priority: task.priority,
    dueDate: task.dueDate,
    title: toStringRecord(task.titleTranslations),
    createdAt: task.createdAt
  };
}

export class ReservationRepository {
  constructor(
    private readonly tx: TenantTransaction,
    private readonly organizationId: string
  ) {}

  async findProperty(propertyId: string): Promise<{ id: string; name: string } | null> {
    return this.tx.property.findFirst({
      where: {
        id: propertyId,
        organizationId: this.organizationId,
        archivedAt: null
      },
      select: {
        id: true,
        name: true
      }
    });
  }

  async listPropertyOptions(): Promise<Array<{ id: string; name: string; city: string }>> {
    return this.tx.property.findMany({
      where: {
        organizationId: this.organizationId,
        archivedAt: null
      },
      orderBy: [{ city: "asc" }, { name: "asc" }],
      select: {
        id: true,
        name: true,
        city: true
      },
      take: 200
    });
  }

  async resolveTaskConfig(): Promise<ReservationTaskConfig | null> {
    const rows = await this.tx.$queryRaw<ConfigRuleRow[]>(
      Prisma.sql`
        SELECT value
        FROM config_rule
        WHERE organization_id = ${this.organizationId}::uuid
          AND key = 'ops.reservation_task_templates'
          AND scope_type = 'organization'
          AND archived_at IS NULL
          AND effective_from <= now()
          AND (effective_to IS NULL OR effective_to > now())
        ORDER BY effective_from DESC, version DESC
        LIMIT 1
      `
    );
    const value = rows[0]?.value;

    if (!value) {
      return null;
    }

    return reservationTaskConfigSchema.parse(value);
  }

  async findReservationByIdempotency(idempotencyKey: string): Promise<ReservationSummary | null> {
    const reservation = await this.tx.reservation.findUnique({
      where: {
        organizationId_idempotencyKey: {
          organizationId: this.organizationId,
          idempotencyKey
        }
      },
      include: {
        property: true,
        _count: {
          select: {
            conflicts: {
              where: {
                status: "OPEN"
              }
            }
          }
        }
      }
    });

    return reservation ? reservationToSummary(reservation) : null;
  }

  async createReservation(input: ManualReservationInput, reference: string, actorId: string) {
    const reservation = await this.tx.reservation.create({
      data: {
        organizationId: this.organizationId,
        propertyId: input.propertyId,
        reference,
        source: input.source,
        status: "CONFIRMED",
        guestName: input.guestName,
        guestEmail: input.guestEmail,
        checkIn: dateToUtc(input.checkIn),
        checkOut: dateToUtc(input.checkOut),
        nights: nightsBetween(input.checkIn, input.checkOut),
        adultCount: input.adultCount,
        childCount: input.childCount,
        notes: input.notes,
        idempotencyKey: input.idempotencyKey,
        createdBy: actorId
      },
      include: {
        property: true,
        _count: {
          select: {
            conflicts: true
          }
        }
      }
    });

    return reservationToSummary(reservation);
  }

  async listReservations(): Promise<ReservationSummary[]> {
    const reservations = await this.tx.reservation.findMany({
      where: {
        organizationId: this.organizationId,
        archivedAt: null
      },
      orderBy: [{ checkIn: "asc" }, { createdAt: "desc" }],
      include: {
        property: true,
        _count: {
          select: {
            conflicts: {
              where: {
                status: "OPEN"
              }
            }
          }
        }
      },
      take: 100
    });

    return reservations.map(reservationToSummary);
  }

  async listOverlaps(input: ManualReservationInput, reservationId: string): Promise<ReservationSummary[]> {
    const overlaps = await this.tx.reservation.findMany({
      where: {
        organizationId: this.organizationId,
        propertyId: input.propertyId,
        archivedAt: null,
        id: {
          not: reservationId
        },
        status: {
          notIn: ["CANCELLED", "NO_SHOW", "CLOSED"]
        },
        checkIn: {
          lt: dateToUtc(input.checkOut)
        },
        checkOut: {
          gt: dateToUtc(input.checkIn)
        }
      },
      include: {
        property: true,
        _count: {
          select: {
            conflicts: true
          }
        }
      }
    });

    return overlaps.map(reservationToSummary);
  }

  async createConflict(
    reservation: ReservationSummary,
    conflictingReservation: ReservationSummary,
    actorId: string
  ): Promise<{ id: string }> {
    return this.tx.reservationConflict.upsert({
      where: {
        organizationId_reservationId_conflictingReservationId: {
          organizationId: this.organizationId,
          reservationId: reservation.id,
          conflictingReservationId: conflictingReservation.id
        }
      },
      update: {},
      create: {
        organizationId: this.organizationId,
        propertyId: reservation.propertyId,
        reservationId: reservation.id,
        conflictingReservationId: conflictingReservation.id,
        reason: "OVERLAPPING_CONFIRMED_RESERVATION",
        status: "OPEN",
        createdBy: actorId
      },
      select: {
        id: true
      }
    });
  }

  async ensureTask(
    reservation: ReservationSummary,
    template: ReservationTaskTemplate,
    actorId: string
  ): Promise<{ task: OperationTaskSummary; created: boolean }> {
    const idempotencyKey = `${reservation.id}:${template.key}`;
    const existing = await this.tx.operationTask.findUnique({
      where: {
        organizationId_idempotencyKey: {
          organizationId: this.organizationId,
          idempotencyKey
        }
      },
      include: {
        property: true,
        reservation: true
      }
    });

    if (existing) {
      return { task: taskToSummary(existing), created: false };
    }

    const task = await this.tx.operationTask.create({
      data: {
        organizationId: this.organizationId,
        propertyId: reservation.propertyId,
        reservationId: reservation.id,
        type: template.type,
        state: "PLANNED",
        priority: template.priority,
        dueDate: template.due === "CHECK_IN" ? reservation.checkIn : reservation.checkOut,
        titleTranslations: taskTitleJson(template),
        idempotencyKey,
        createdBy: actorId
      },
      include: {
        property: true,
        reservation: true
      }
    });

    return { task: taskToSummary(task), created: true };
  }

  async listTasks(): Promise<OperationTaskSummary[]> {
    const tasks = await this.tx.operationTask.findMany({
      where: {
        organizationId: this.organizationId,
        archivedAt: null
      },
      orderBy: [{ dueDate: "asc" }, { createdAt: "asc" }],
      include: {
        property: true,
        reservation: true
      },
      take: 200
    });

    return tasks.map(taskToSummary);
  }

  async tasksForReservation(reservationId: string): Promise<OperationTaskSummary[]> {
    const tasks = await this.tx.operationTask.findMany({
      where: {
        organizationId: this.organizationId,
        reservationId,
        archivedAt: null
      },
      orderBy: [{ dueDate: "asc" }, { createdAt: "asc" }],
      include: {
        property: true,
        reservation: true
      }
    });

    return tasks.map(taskToSummary);
  }
}
