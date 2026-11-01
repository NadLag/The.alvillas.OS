import { z } from "zod";
import { employeeCompensationSettlementInput } from "./employee-compensation-settlement";
import { employeeCompensationSubmissionViewSchema } from "./employee-compensation-claim";
import {employeeCompensationRunDetailSchema} from "./employee-compensation-workspace";
const id=z.uuid().transform(value=>value.toLowerCase()),money=employeeCompensationSubmissionViewSchema.shape.total;
export const employeeCompensationPaymentWorkspaceInput=z.object({id,claimId:id,kind:employeeCompensationSettlementInput.shape.kind.default("PAYMENT"),amount:employeeCompensationSettlementInput.shape.amount.optional(),paidLocal:z.string().trim().min(1).max(32).optional(),occurrence:z.enum(["reject","earlier","later"]).default("reject"),fundingQuery:z.string().trim().max(120).default(""),fundingAfter:id.optional(),fundingAccountId:id.optional(),before:id.optional()}).strict();
export const employeeCompensationPaymentWorkspaceSchema=z.object({id:z.uuid(),claimId:z.uuid(),purpose:z.string(),personName:z.string().nullable(),earned:money,outstanding:money,minorUnit:z.number().int().nonnegative(),timezone:z.string().nullable(),canPrepare:z.boolean(),
  percentageEvidence:z.array(z.object({runLineId:z.uuid(),coverage:employeeCompensationRunDetailSchema.shape.labels.element.shape.percentageCoverage.unwrap()}).strict()).min(1).max(10000).optional(),
  blocked:z.enum(["calendar_unavailable","posting_forbidden","no_outstanding","source_reversed"]).nullable(),
  preview:z.object({kind:employeeCompensationSettlementInput.shape.kind,amount:employeeCompensationSettlementInput.shape.amount.nullable(),paidLocal:z.string().nullable(),paidAt:z.iso.datetime().nullable(),occurrence:z.enum(["reject","earlier","later"]),closed:z.boolean(),canAdjust:z.boolean(),canPay:z.boolean(),calendarRuleId:z.uuid().nullable(),calendarRuleVersion:z.number().int().positive().nullable(),error:z.enum(["clock","future","amount","closed","forbidden","wallet_unavailable"]).nullable()}).strict(),
  accounts:z.array(z.object({id:z.uuid(),name:z.string()}).strict()).max(51),fundingNext:z.uuid().nullable(),walletAvailable:money.nullable(),
  payments:z.array(z.object({id:z.uuid(),kind:employeeCompensationSettlementInput.shape.kind,amount:money,paidAt:z.iso.datetime(),postedAt:z.iso.datetime(),recordedAt:z.iso.datetime(),fundingName:z.string(),reference:z.string().nullable(),reason:z.string(),reversal:z.object({id:z.uuid(),at:z.iso.datetime(),reason:z.string()}).strict().nullable(),canVoid:z.boolean()}).strict()).max(50),next:z.uuid().nullable()
}).strict();
