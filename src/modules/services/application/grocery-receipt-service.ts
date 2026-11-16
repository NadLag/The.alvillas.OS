import {z} from "zod";
import {prisma} from "@/platform/db/client";
import {withTenant,type TenantTransactionRunner} from "@/platform/db/tenant";
import type {AccountActorContext} from "@/platform/authz/session-context";
import {nativeGroceryReceiptContext} from "@/platform/services/grocery-receipt-context";
export async function readGroceryExpenseReceipts(actor:AccountActorContext,raw:unknown,deps:{db?:TenantTransactionRunner}){const input=z.object({expenseId:z.uuid(),before:z.uuid().optional()}).strict().parse(raw);return withTenant(deps.db??prisma,actor.organizationId,tx=>nativeGroceryReceiptContext(actor,tx,input.expenseId,input.before));}
