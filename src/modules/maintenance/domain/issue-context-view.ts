import {localizedTextSchema} from "@/i18n/content";
import {z} from "zod";
import {maintenanceIssueSourceSchema,maintenanceIssueLinkIntentSchema,maintenanceIssueLinkReceiptSchema} from "./issue-context";
const id=z.uuid(),kind=z.enum(["PROPERTY","RESERVATION","GUEST","TASK","PERSON","SUPPLIER","EXPENSE","ASSET","PHOTO","DOCUMENT"]),version=z.string().regex(/^(?:0|[1-9]\d{0,18})$/u);
export const maintenanceSourceNavigationSchema=z.discriminatedUnion("kind",[z.object({kind:z.literal("FIELD_EVIDENCE"),id}).strict(),z.object({kind:z.literal("DOCUMENT_VERSION"),documentId:id,version:z.number().int().positive()}).strict()]);
const authorizationStamp=z.string().regex(/^[a-f0-9]{64}$/u);
export const maintenanceIssueViewSchema=z.object({authorizationStamp,issue:z.object({id,taskId:id,propertyId:id,title:z.string(),description:z.string(),severity:z.string(),state:z.string(),evidenceId:id.nullable()}).strict(),version,capabilities:z.object({edit:z.boolean()}).strict(),sources:z.array(z.discriminatedUnion("state",[
 z.object({state:z.literal("VISIBLE"),contextId:id,reference:maintenanceIssueSourceSchema,label:z.string(),labels:localizedTextSchema.optional(),navigation:maintenanceSourceNavigationSchema.optional(),dataClass:z.enum(["operational","personal","guest","financial","sensitive"])}).strict(),
 z.object({state:z.literal("MASKED"),contextId:id,kind}).strict()
])).max(50)}).strict();
export type MaintenanceIssueView=z.infer<typeof maintenanceIssueViewSchema>;
const detail=z.object({reference:maintenanceIssueSourceSchema,label:z.string(),reason:z.string(),labels:localizedTextSchema.optional(),navigation:maintenanceSourceNavigationSchema.optional(),dataClass:z.enum(["operational","personal","guest","financial","sensitive"])}).strict();
export const maintenanceIssueHistorySchema=z.object({authorizationStamp,items:z.array(z.object({id,version,operation:z.enum(["ATTACH","DETACH"]),kind,createdAt:z.iso.datetime(),actor:z.enum(["SELF","OTHER"]),detail:detail.nullable()}).strict()).max(20),next:version.nullable()}).strict();
export const maintenanceIssueChoicesSchema=z.object({authorizationStamp,ready:z.boolean(),items:z.array(z.object({reference:maintenanceIssueSourceSchema,label:z.string(),labels:localizedTextSchema.optional(),navigation:maintenanceSourceNavigationSchema.optional(),dataClass:z.enum(["operational","personal","guest","financial","sensitive"])}).strict()).max(20),next:z.string().max(6000).nullable()}).strict();
export const maintenanceIssueReviewSchema=z.object({authorizationStamp,intent:maintenanceIssueLinkIntentSchema,reviewFingerprint:z.string().regex(/^[a-f0-9]{64}$/u),source:z.object({reference:maintenanceIssueSourceSchema,label:z.string(),labels:localizedTextSchema.optional(),navigation:maintenanceSourceNavigationSchema.optional(),dataClass:z.enum(["operational","personal","guest","financial","sensitive"])}).strict()}).strict();
export const maintenanceIssueRecoverySchema=z.discriminatedUnion("recorded",[z.object({recorded:z.literal(true),receipt:maintenanceIssueLinkReceiptSchema}).strict(),z.object({recorded:z.literal(false),receipt:z.null()}).strict()]);
