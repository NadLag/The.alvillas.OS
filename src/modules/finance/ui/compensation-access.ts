import "server-only";
import { redirect } from "next/navigation";
import { auth } from "@/platform/auth/session";
import { financeActorContextFromSession } from "../application/finance-access";

export async function requireCompensationSession(locale:string){
  const actor=await financeActorContextFromSession(await auth());if(!actor)redirect(`/${locale}/login`);return actor;
}
