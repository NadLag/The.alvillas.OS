import { z } from "zod";

export const maintenanceSlaPolicyKey = "ops.maintenance_sla";
const interval = z.object({
  response_minutes: z.number().int().positive().max(2147483647),
  completion_minutes: z.number().int().positive().max(2147483647)
}).strict().refine(value => value.completion_minutes >= value.response_minutes, { path: ["completion_minutes"] });

export const maintenanceSlaPolicySchema = z.object({
  priorities: z.object({ LOW: interval, NORMAL: interval, HIGH: interval, URGENT: interval }).strict()
}).strict();

export type MaintenanceSlaPolicy = z.infer<typeof maintenanceSlaPolicySchema>;
