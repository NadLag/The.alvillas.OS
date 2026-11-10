import {z} from "zod";
import {onboardingIdSchema} from "./onboarding-contract";

const fields={sessionId:onboardingIdSchema,previousRevisionId:onboardingIdSchema,query:z.string().trim().max(120),cursor:z.string().max(6000).optional()};
export const onboardingTeamChoicesInputSchema=z.discriminatedUnion("kind",[
 z.object({...fields,kind:z.literal("ASSIGNMENTS")}).strict(),
 z.object({...fields,kind:z.literal("PEOPLE")}).strict(),
 z.object({...fields,kind:z.literal("ROLES")}).strict(),
 z.object({...fields,kind:z.literal("ACCOUNTS"),personId:onboardingIdSchema}).strict()
]);
const tail={next:z.string().nullable()};
export const onboardingTeamChoicesSchema=z.discriminatedUnion("kind",[
 z.object({kind:z.literal("ASSIGNMENTS"),assignments:z.array(z.object({id:onboardingIdSchema,personId:onboardingIdSchema,roleId:onboardingIdSchema,userAccountId:onboardingIdSchema.nullable(),personName:z.string(),roleName:z.string(),validFrom:z.iso.datetime(),validTo:z.iso.datetime().nullable()}).strict()).max(20),...tail}).strict(),
 z.object({kind:z.literal("PEOPLE"),people:z.array(z.object({id:onboardingIdSchema,displayName:z.string()}).strict()).max(20),...tail}).strict(),
 z.object({kind:z.literal("ROLES"),roles:z.array(z.object({id:onboardingIdSchema,name:z.string(),canAssign:z.boolean()}).strict()).max(20),...tail}).strict(),
 z.object({kind:z.literal("ACCOUNTS"),personId:onboardingIdSchema,accounts:z.array(z.object({id:onboardingIdSchema,personId:onboardingIdSchema,email:z.string().nullable(),status:z.literal("ACTIVE")}).strict()).max(20),...tail}).strict()
]);
export type OnboardingTeamChoicesInput=z.infer<typeof onboardingTeamChoicesInputSchema>;
