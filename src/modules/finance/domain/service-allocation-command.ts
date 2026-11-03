import {z} from "zod";

const identity=z.uuid().transform(value=>value.toLowerCase()),reason=z.string().trim().min(6).max(500);
export const serviceCollectionSourceInput=z.object({collectionId:identity,completionEventId:identity}).strict();
const selection=z.object({componentKey:z.string().regex(/^[a-z][a-z0-9_.-]{0,99}$/u),bindingId:identity}).strict();
export const serviceAllocationReviewInput=serviceCollectionSourceInput.extend({serviceKey:z.string().regex(/^[a-z][a-z0-9_.-]{0,99}$/u),providers:z.array(selection).max(100)}).strict();
export const serviceAllocationAdmissionInput=serviceAllocationReviewInput.extend({expectedVersion:z.number().int().min(0),reviewFingerprint:z.string().regex(/^[a-f0-9]{64}$/u),idempotencyKey:identity,reason}).strict();
export const serviceProviderBindingInput=serviceCollectionSourceInput.extend({sourceKind:z.enum(["SUPPLIER_INVOICE_LINE","EMPLOYEE_COST"]),costId:identity,operation:z.enum(["ATTACH","RELEASE"]),expectedVersion:z.number().int().min(0),idempotencyKey:identity,reason}).strict();
export const serviceAllocationRecognitionInput=z.object({sourceId:identity,admissionId:identity,expectedPostingVersion:z.number().int().min(0),idempotencyKey:identity,reason,currentPeriod:z.boolean().optional()}).strict();
export const serviceAllocationReversalInput=z.object({postingId:identity,expectedPostingVersion:z.number().int().min(1),idempotencyKey:identity,reason}).strict();

export const serviceAllocationCommandSchema=z.discriminatedUnion("operation",[
 z.object({operation:z.literal("BIND"),input:serviceProviderBindingInput.omit({idempotencyKey:true}),idempotencyKey:identity}).strict(),
 z.object({operation:z.literal("ADMIT"),input:serviceAllocationAdmissionInput.omit({idempotencyKey:true}),idempotencyKey:identity}).strict(),
 z.object({operation:z.literal("RECOGNIZE"),input:serviceAllocationRecognitionInput.omit({idempotencyKey:true}),idempotencyKey:identity}).strict(),
 z.object({operation:z.literal("REVERSE"),input:serviceAllocationReversalInput.omit({idempotencyKey:true}),idempotencyKey:identity}).strict()
]);
const operation=z.enum(["BIND","ADMIT","RECOGNIZE","REVERSE"]),base={requestId:identity,idempotencyKey:identity,operation};
export const serviceAllocationCommandSuccessSchema=z.object({...base,state:z.literal("SUCCEEDED"),failureCode:z.null(),sourceId:identity,resultId:identity,version:z.number().int().positive(),idempotent:z.boolean()}).strict();
export const serviceAllocationCommandResultSchema=z.union([serviceAllocationCommandSuccessSchema,z.object({...base,state:z.literal("CONFLICT"),failureCode:z.literal("SOURCE_CHANGED")}).strict(),z.object({...base,state:z.literal("FAILED"),failureCode:z.enum(["CONFIGURATION_UNAVAILABLE","SOURCE_UNAVAILABLE","PERIOD_CLOSED"])}).strict()]);
export const serviceAllocationCommandRecoverySchema=z.object({key:identity}).strict();
export const serviceAllocationCommandRecoveryResultSchema=z.object({request:serviceAllocationCommandSuccessSchema.nullable()}).strict();
export type ServiceAllocationCommand=z.infer<typeof serviceAllocationCommandSchema>;
