import type {NextRequest} from "next/server";
import {prisma} from "@/platform/db/client";
import {leadHttp} from "@/modules/crm/ui/lead-http";
import {readLeadAnalyticsOptions} from "@/modules/crm/application/lead-analytics-service";
export async function POST(request:NextRequest){return leadHttp(request,(actor,input,requestId)=>readLeadAnalyticsOptions(actor,input,{db:prisma,requestId}),"F-CRM-08");}
