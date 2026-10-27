import type { ReactNode } from "react";
import { notFound,redirect } from "next/navigation";
import { safeLocale } from "@/i18n/routing";
import { auth } from "@/platform/auth/session";
import { financeActorContextFromSession } from "@/modules/finance/application/finance-access";
import { assertFinancialTransferViewer,FinancialTransferAccessError } from "@/modules/finance/application/financial-transfer-service";

export default async function FinancialTransfersLayout({children,params}:{children:ReactNode;params:Promise<{locale:string}>}){
  const {locale}=await params,actor=await financeActorContextFromSession(await auth());if(!actor)redirect(`/${safeLocale(locale)}/login`);
  try{await assertFinancialTransferViewer(actor)}catch(error){if(error instanceof FinancialTransferAccessError)notFound();throw error}
  return children;
}
