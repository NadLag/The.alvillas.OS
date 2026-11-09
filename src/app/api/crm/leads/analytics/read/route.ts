import type {NextRequest} from "next/server";
import {prisma} from "@/platform/db/client";
import {leadHttp} from "@/modules/crm/ui/lead-http";
import {readLeadAnalytics} from "@/modules/crm/application/lead-analytics-service";
export async function POST(request:NextRequest){return leadHttp(request,(actor,input,requestId)=>readLeadAnalytics(actor,input,{db:prisma,requestId}),"F-CRM-08");}
