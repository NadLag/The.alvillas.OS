import type {NextRequest} from "next/server";
import {prisma} from "@/platform/db/client";
import {leadHttp} from "@/modules/crm/ui/lead-http";
import {reviewLeadStage} from "@/modules/crm/application/lead-stage-service";
export async function POST(request:NextRequest){return leadHttp(request,(actor,input,requestId)=>reviewLeadStage(actor,input,{db:prisma,requestId}),"F-CRM-02");}
