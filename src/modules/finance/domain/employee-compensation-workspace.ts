import { z } from "zod";
import { localizedTextSchema } from "@/i18n/content";
import { employeeCompensationRunViewSchema } from "./employee-compensation-run";
const duration=z.object({hours:z.string().regex(/^\d+$/u),minutes:z.string().regex(/^\d+$/u),seconds:z.string().regex(/^\d+(?:\.\d{1,3})?$/u)}).strict();
const hourlyCoverage=z.object({evidenceVersion:z.number().int().positive(),validatedAt:z.iso.datetime(),milliseconds:z.string().regex(/^[1-9]\d*$/u),duration,
  rates:z.array(z.object({startsAt:z.iso.datetime(),endsAt:z.iso.datetime(),duration,contractVersion:z.number().int().positive(),rate:employeeCompensationRunViewSchema.shape.total}).strict()).min(1)}).strict();
const percentageCoverage=z.object({baseAmount:employeeCompensationRunViewSchema.shape.total,amount:employeeCompensationRunViewSchema.shape.total,baseCount:z.number().int().positive(),journalCount:z.number().int().positive(),sources:z.array(z.object({postingId:z.uuid(),transactionId:z.uuid(),reference:z.string(),occurredAt:z.iso.datetime(),amount:employeeCompensationRunViewSchema.shape.total,rate:employeeCompensationRunViewSchema.shape.total,contractVersion:z.number().int().positive()}).strict()).min(1).max(10000)}).strict();

export const employeeCompensationRunDetailSchema=employeeCompensationRunViewSchema.extend({
  labels:z.array(z.object({lineId:z.uuid(),personName:z.string().nullable(),propertyName:z.string().nullable(),roleName:z.string(),
    contractVersion:z.number().int().positive(),effectiveFrom:z.iso.datetime(),sourceTitle:localizedTextSchema.nullable(),canViewTask:z.boolean(),
    percentageCoverage:percentageCoverage.optional(),hourlyCoverage:hourlyCoverage.optional(),monthlyCoverage:z.object({month:z.string(),eligibleDays:z.number().int().positive(),calendarDays:z.number().int().positive(),proration:z.enum(["FULL_CALENDAR_MONTH_ONLY","COMPLETE_ELIGIBLE_CALENDAR_DAYS"]),rateSelection:z.enum(["AT_FIRST_ELIGIBLE_DAY","DAILY_EFFECTIVE"]),rates:z.array(z.object({fromOn:z.iso.date(),toOn:z.iso.date(),days:z.number().int().positive(),contractVersion:z.number().int().positive(),rate:employeeCompensationRunViewSchema.shape.total}).strict()).min(1).max(31)}).strict().optional(),earningKind:z.enum(["PER_MONTH","PER_HOUR","PERCENTAGE"]).optional(),earningPeriodKey:z.string().optional(),completionMethod:z.enum(["SELF","OFFLINE_SYNC","PROXY"]).nullable(),validatorName:z.string().nullable(),validatedAt:z.iso.datetime({offset:true}).nullable()}).strict()).max(50),
  canCancel:z.boolean()
}).strict();
export const employeeCompensationRunListSchema=z.object({
  runs:z.array(employeeCompensationRunViewSchema.pick({id:true,purpose:true,state:true,fromOn:true,toOn:true,timezone:true,createdAt:true,total:true,lineCount:true})).max(10),
  next:z.string().nullable(),canCreate:z.boolean()
}).strict();
