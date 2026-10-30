import { z } from "zod";
import type { FinanceActorContext } from "./finance-access";
import { employeeCompensationPreviewInput, previewEmployeeCompensation } from "./employee-compensation-service";
import { employeeCompletedWorkInput, previewEmployeeCompletedWork } from "./employee-completed-work-service";

const requestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("contract"), input: employeeCompensationPreviewInput }).strict(),
  z.object({ kind: z.literal("completed_work"), input: employeeCompletedWorkInput }).strict()
]);
export function previewEmployeeCompensationRequest(ctx: FinanceActorContext, raw: unknown, requestId: string) {
  const request = requestSchema.parse(raw);
  return request.kind === "contract" ? previewEmployeeCompensation(ctx, request.input, { requestId }) :
    previewEmployeeCompletedWork(ctx, request.input, { requestId });
}
