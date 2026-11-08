import type {NextRequest} from "next/server";
import {prisma} from "@/platform/db/client";
import {leadHttp} from "@/modules/crm/ui/lead-http";
import {readLeadWorkOptions} from "@/modules/crm/application/lead-work-service";
export async function POST(request:NextRequest){return leadHttp(request,(actor,input,requestId)=>readLeadWorkOptions(actor,input,{db:prisma,requestId}),"F-CRM-04");}
