import { z } from "zod";
import { employeeCompensationSubmissionViewSchema } from "./employee-compensation-claim";
import { employeeCompensationRunDetailSchema } from "./employee-compensation-workspace";

export const employeeCompensationCostDetailSchema=employeeCompensationSubmissionViewSchema.extend({labels:employeeCompensationRunDetailSchema.shape.labels,canOpenApproval:z.boolean(),
  costs:z.array(employeeCompensationSubmissionViewSchema.shape.costs.element.extend({recordedCompletionAt:z.iso.datetime(),timezone:z.string()}).strict()).max(50)}).strict();
export const employeeCompensationCostWorkspaceSchema=z.object({
  run:employeeCompensationRunDetailSchema.pick({id:true,purpose:true,state:true,fromOn:true,toOn:true,timezone:true,total:true,lineCount:true}),
  canPrepare:z.boolean(),blocked:z.enum(["run_cancelled","no_positive_work","active_source","forbidden"]).nullable(),positiveLineIds:z.array(z.uuid()).max(10000),
  proposals:z.array(employeeCompensationSubmissionViewSchema.pick({id:true,state:true,costOn:true,createdAt:true,total:true,costCount:true,claimCount:true})).max(10),next:z.string().nullable()
}).strict();
