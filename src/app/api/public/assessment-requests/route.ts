import type {NextRequest} from "next/server";
import {prisma} from "@/platform/db/client";
import {captureWebsiteLead,configuredWebsiteLeadOrganization} from "@/modules/crm/application/lead-capture-service";
import {websiteLeadHttp} from "@/modules/crm/ui/lead-http";
export async function POST(request:NextRequest){return websiteLeadHttp(request,(input,requestId)=>captureWebsiteLead(configuredWebsiteLeadOrganization(),input,{db:prisma,requestId}));}
