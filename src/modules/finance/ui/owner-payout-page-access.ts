import "server-only";
import { cache } from "react";
import { notFound } from "next/navigation";
import { z } from "zod";
import { ownerLedgerActor } from "./owner-ledger-access";
import { getOwnerPayout,OwnerPayoutAccessError } from "../application/owner-payout-service";

export const ownerPayoutPage=cache(async(locale:string,id:string)=>{
  const actor=await ownerLedgerActor(locale);
  try{return await getOwnerPayout(actor,id);}
  catch(error){if(error instanceof OwnerPayoutAccessError||error instanceof z.ZodError)notFound();throw error;}
});
