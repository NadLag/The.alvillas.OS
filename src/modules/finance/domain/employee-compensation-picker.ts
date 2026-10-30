import { z } from "zod";
import { employeeCompensationRunDetailSchema } from "./employee-compensation-workspace";
import { employeeCompensationRunViewSchema } from "./employee-compensation-run";

export const employeeCompensationEditorSchema=z.object({baseCurrency:z.string().regex(/^[A-Z]{3}$/u),currencies:z.array(z.string().regex(/^[A-Z]{3}$/u)),
  date:z.iso.date(),timezone:z.string(),maxPeriodDays:z.number().int().positive()}).strict();
export const employeeCompensationChoiceSchema=employeeCompensationRunDetailSchema.shape.labels.element.omit({lineId:true}).extend({
  assignmentId:z.uuid(),compensationId:z.uuid(),rate:employeeCompensationRunViewSchema.shape.total
}).strict();
export const employeeCompensationWorkSchema=z.object({timezone:z.string(),items:z.array(z.object({taskId:z.uuid(),recordedCompletionAt:z.iso.datetime(),choices:z.array(employeeCompensationChoiceSchema).min(1)}).strict()).max(25),next:z.string().nullable()}).strict();
