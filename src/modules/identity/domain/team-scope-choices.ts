import {z} from "zod";
export const teamScopeChoiceInput=z.object({type:z.enum(["property","region","city"]),query:z.string().trim().max(120).default(""),after:z.uuid().optional()}).strict();
export const teamScopeChoicePage=z.object({items:z.array(z.object({id:z.uuid(),name:z.string()}).strict()).max(25),next:z.uuid().nullable()}).strict();
export const teamScopeChoiceResult=z.discriminatedUnion("status",[z.object({status:z.literal("ready"),data:teamScopeChoicePage}).strict(),z.object({status:z.enum(["invalid","denied","unavailable"])}).strict()]);
