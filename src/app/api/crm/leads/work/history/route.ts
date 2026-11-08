import type {NextRequest} from "next/server";
import {prisma} from "@/platform/db/client";
import {leadHttp} from "@/modules/crm/ui/lead-http";
import {readLeadWorkHistory} from "@/modules/crm/application/lead-work-service";
export async function POST(request:NextRequest){return leadHttp(request,(actor,input,requestId)=>readLeadWorkHistory(actor,input,{db:prisma,requestId}),"F-CRM-04");}
