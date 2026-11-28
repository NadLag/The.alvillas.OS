import {prisma} from "@/platform/db/client";
import {withTenant,type TenantTransactionRunner} from "@/platform/db/tenant";
import type {AccountActorContext} from "@/platform/authz/session-context";
import {nativeGroceryPurchaseHistory} from "@/platform/services/grocery-purchase-history";
import {groceryPurchaseHistoryInput} from "../domain/grocery-expense";
export function readGroceryPurchaseHistory(actor:AccountActorContext,raw:unknown,deps:{db?:TenantTransactionRunner;requestId?:string}={}){const input=groceryPurchaseHistoryInput.parse(raw);return withTenant(deps.db??prisma,actor.organizationId,tx=>nativeGroceryPurchaseHistory(actor,tx,input,deps.requestId??crypto.randomUUID()),{timeout:120000});}
