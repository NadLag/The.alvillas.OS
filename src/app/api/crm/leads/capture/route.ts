import type {NextRequest} from "next/server";
import {prisma} from "@/platform/db/client";
import {captureLead} from "@/modules/crm/application/lead-capture-service";
import {leadHttp} from "@/modules/crm/ui/lead-http";
export async function POST(request:NextRequest){return leadHttp(request,(actor,input,requestId)=>captureLead(actor,input,{db:prisma,requestId}));}
