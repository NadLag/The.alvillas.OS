import {createTaskSchema} from "@/modules/reservations/domain/operation-task";

/** The native operation command remains the sole task contract. Property,
 * reservation, title, date, actor and nonce come from the reviewed order. */
export const serviceOrderTaskPlanSchema=createTaskSchema.pick({type:true,priority:true,checklistTemplateKey:true});
