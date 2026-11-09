import type {NextRequest} from "next/server";
import {prisma} from "@/platform/db/client";
import {leadHttp} from "@/modules/crm/ui/lead-http";
import {readLeadConversionChoices} from "@/modules/crm/application/lead-conversion-service";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export async function POST(request:NextRequest){return leadHttp(request,(actor,input,requestId)=>readLeadConversionChoices(actor,input,{db:prisma,requestId}),"F-CRM-07");}
