import type {NextRequest} from "next/server";
import {prisma} from "@/platform/db/client";
import {leadHttp} from "@/modules/crm/ui/lead-http";
import {listLeadWorkspace} from "@/modules/crm/application/lead-workspace-service";
export async function POST(request:NextRequest){return leadHttp(request,(actor,input,requestId)=>listLeadWorkspace(actor,input,{db:prisma,requestId}),"F-CRM-03");}
