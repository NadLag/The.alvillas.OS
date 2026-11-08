import type { NextRequest } from "next/server";
import { prisma } from "@/platform/db/client";
import { compensationHttp } from "@/modules/finance/ui/compensation-http";
import { configuredFinancialAttachmentObjects } from "@/modules/finance/application/financial-attachment-files";
import { completeFinancialAttachmentParts } from "@/modules/finance/application/financial-attachment-parts";
export async function POST(request:NextRequest){return compensationHttp(request,(actor,input,requestId)=>completeFinancialAttachmentParts(actor,input,{db:prisma,requestId,objects:configuredFinancialAttachmentObjects()}),{json:true,rejectQuery:true,maxBytes:16384,feature:"F-FIN-38.complete"});}
