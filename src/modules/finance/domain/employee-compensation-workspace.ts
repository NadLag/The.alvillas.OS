import { z } from "zod";
import { localizedTextSchema } from "@/i18n/content";
import { employeeCompensationRunViewSchema } from "./employee-compensation-run";

export const employeeCompensationRunDetailSchema=employeeCompensationRunViewSchema.extend({
  labels:z.array(z.object({lineId:z.uuid(),personName:z.string().nullable(),propertyName:z.string().nullable(),roleName:z.string(),
    contractVersion:z.number().int().positive(),effectiveFrom:z.iso.datetime(),sourceTitle:localizedTextSchema.nullable(),canViewTask:z.boolean(),
    completionMethod:z.enum(["SELF","OFFLINE_SYNC","PROXY"]),validatorName:z.string().nullable(),validatedAt:z.iso.datetime({offset:true}).nullable()}).strict()).max(50),
  canCancel:z.boolean()
}).strict();
export const employeeCompensationRunListSchema=z.object({
  runs:z.array(employeeCompensationRunViewSchema.pick({id:true,purpose:true,state:true,fromOn:true,toOn:true,timezone:true,createdAt:true,total:true,lineCount:true})).max(10),
  next:z.string().nullable(),canCreate:z.boolean()
}).strict();
