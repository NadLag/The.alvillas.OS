import {z} from "zod";
import {serviceAllocationPolicySchema,serviceAllocationRecipeSchema} from "@/platform/config/service-allocation-policy";

export const identity=z.uuid().transform(value=>value.toLowerCase());
export const sourceSchema=z.object({kind:z.literal("COMPLETED_SERVICE_COLLECTION"),collectionId:identity,transactionId:identity,taskId:identity,propertyId:identity,reservationId:identity.nullable(),completionEventId:identity,performedByPersonId:identity,completedAt:z.iso.datetime(),recordedAt:z.iso.datetime(),currencyMinorUnit:z.number().int().min(0).max(2)}).strict();
export const serviceAllocationOwnerSchema=z.object({ownerId:identity,ownerName:z.string().min(1),shareBps:z.number().int().min(0).max(10000)}).strict();
const moneySchema=z.object({amount:z.string().regex(/^(?:0|[1-9]\d{0,15})\.\d{2}$/u),currency:z.string().regex(/^[A-Z]{3}$/u)}).strict(),slug=z.string().regex(/^[a-z][a-z0-9_.-]{0,99}$/u);
export const serviceAllocationSnapshotSchema=z.object({
 schemaVersion:z.literal(1),source:sourceSchema.extend({amount:moneySchema}).strict(),
 rules:z.object({allocation:z.object({id:identity,version:z.number().int().positive(),source:serviceAllocationPolicySchema.shape.source,ruleSelection:serviceAllocationPolicySchema.shape.rule_selection,ownershipBasis:serviceAllocationPolicySchema.shape.ownership_basis}).strict(),tax:z.object({id:identity,version:z.number().int().positive()}).strict()}).strict(),
 recipe:serviceAllocationRecipeSchema,parts:z.array(z.object({key:slug,beneficiary:z.enum(["OWNER","COMPANY","SUPPLIER","PERSON","TAX"]),amount:moneySchema,taxRuleKey:slug.nullable()}).strict()).min(1).max(100),
 taxes:z.array(z.object({ruleKey:slug,amount:moneySchema,policyRuleId:identity,policyVersion:z.number().int().positive(),method:z.enum(["FIXED","BASIS_POINTS"]),configuredValue:z.union([z.object({amount:moneySchema.shape.amount}).strict(),z.object({rateBps:z.number().int().min(0).max(10000)}).strict()]),basis:z.literal("ACTUAL_COLLECTED_GROSS"),rounding:z.literal("HALF_UP_AT_LEDGER_PRECISION"),gross:moneySchema}).strict()).min(1).max(20),
 owners:z.array(serviceAllocationOwnerSchema),providerCosts:z.array(z.object({componentKey:slug,bindingId:identity,sourceKind:z.enum(["SUPPLIER_INVOICE_LINE","EMPLOYEE_COST"]),costId:identity,transactionId:identity,partyId:identity,amount:moneySchema}).strict()).max(100)
}).strict();
