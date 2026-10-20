import type { TenantTransaction } from "@/platform/db/tenant";
import { AutomationRepository } from "./repository";
import { automationRuleSchema, dueDate, type EvaluationContext } from "./rule";

// Reservation changes use the original automation definition and outcome IDs,
// alongside the existing frozen reservation task templates.
export async function reservationAutomationDates(
  tx: TenantTransaction,
  organizationId: string,
  reservation: { id: string; checkIn: Date; checkOut: Date },
) {
  const dates = new Map<string, Date>();
  for (const run of await new AutomationRepository(
    tx,
    organizationId,
  ).reservationPlans(reservation.id)) {
    const frozen = run.inputs as unknown as EvaluationContext;
    const context: EvaluationContext = {
      fields: {
        ...frozen.fields,
        reservation: {
          id: reservation.id,
          check_in: reservation.checkIn.toISOString().slice(0, 10),
          check_out: reservation.checkOut.toISOString().slice(0, 10),
          nights:
            (reservation.checkOut.getTime() - reservation.checkIn.getTime()) /
            86400000,
        },
      },
      configs: frozen.configs,
    };
    const outputs = run.outputs as Array<{
      key: string;
      producedIds: string[];
    }>;
    for (const action of automationRuleSchema.parse(run.rule.value).actions) {
      if (action.type !== "create_task") continue;
      const output = outputs.find((o) => o.key === action.key);
      for (const id of output?.producedIds ?? [])
        dates.set(id, new Date(dueDate(action, context) + "T00:00:00Z"));
    }
  }
  return dates;
}
