import type {NextRequest} from "next/server";
import {prisma} from "@/platform/db/client";
import {leadHttp} from "@/modules/crm/ui/lead-http";
import {recoverLeadProfile} from "@/modules/crm/application/lead-profile-service";
export async function POST(request:NextRequest){return leadHttp(request,(actor,input,requestId)=>recoverLeadProfile(actor,input,{db:prisma,requestId}),"F-CRM-03");}
