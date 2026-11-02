import {z} from "zod";
import {ownerPayoutDraftSchema} from "./owner-payout-input";
import {payoutCadenceSchema,payoutCalendarSchema,payoutCronSchema} from "@/platform/time/payout-calendar-schema";
export const recurringPayoutDraftPolicyKey="finance.recurring_payout_drafts";
export const periodicPayoutDraftCalendarSchema=z.object({cadence:payoutCadenceSchema.extract(["WEEKLY","MONTHLY","FIFTEEN_DAY","CUSTOM_CRON"]),cron:payoutCronSchema.optional(),schedule:payoutCalendarSchema.optional()}).strict();
export const recurringPayoutDraftTargetSchema=z.object({id:z.uuid().transform(value=>value.toLowerCase()),starts_at:z.iso.datetime({offset:true}).transform(value=>new Date(value).toISOString()),calendar:periodicPayoutDraftCalendarSchema,
 draft:ownerPayoutDraftSchema.omit({amount:true,reason:true,idempotencyKey:true,reservationId:true,expectedSettlementAt:true}).transform(value=>({...value,ownerId:value.ownerId.toLowerCase(),propertyId:value.propertyId.toLowerCase(),payoutMethodId:value.payoutMethodId.toLowerCase(),fundingAccountId:value.fundingAccountId.toLowerCase()}))}).strict();
export const recurringPayoutDraftPolicySchema=z.object({source:z.literal("CURRENT_DERIVED_OWNER_PAYABLE"),principal:z.literal("CURRENT_CONFIGURATION_AUTHOR"),amount_source:z.literal("NATIVE_UNCOMMITTED_PAYABLE"),missed_slots:z.literal("LATEST_DUE_SLOT"),open_payouts:z.literal("WAIT_FOR_TERMINAL"),batch_size:z.number().int().min(1).max(500),targets:z.array(recurringPayoutDraftTargetSchema).max(10000)}).strict().refine(value=>new Set(value.targets.map(row=>row.id)).size===value.targets.length,{message:"Proposal schedule identities must be distinct"});
export class RecurringPayoutDraftConfigurationError extends Error{}
