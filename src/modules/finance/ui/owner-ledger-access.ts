import "server-only";
import { notFound,redirect } from "next/navigation";
import { z } from "zod";
import { auth } from "@/platform/auth/session";
import { financeActorContextFromSession } from "../application/finance-access";
import { assertOwnerLedgerViewer,assertOwnerLedgerScope,OwnerLedgerAccessError } from "../application/owner-ledger-service";

export async function ownerLedgerActor(locale:string){const actor=await financeActorContextFromSession(await auth());if(!actor)redirect(`/${locale}/login`);return actor}
export async function requireOwnerLedgerAccess(locale:string,ownerId?:string,propertyId?:string){
  const actor=await ownerLedgerActor(locale);
  try{if(ownerId)await assertOwnerLedgerScope(actor,ownerId,propertyId);else await assertOwnerLedgerViewer(actor)}
  catch(error){if(error instanceof OwnerLedgerAccessError||error instanceof z.ZodError)notFound();throw error}
}
