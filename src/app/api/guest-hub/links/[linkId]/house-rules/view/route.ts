import type {NextRequest} from "next/server";
import {prisma} from "@/platform/db/client";
import {guestHubHouseRulesPublicHttp} from "@/modules/guest-hub/ui/guest-hub-house-rules-public-http";
export async function POST(request:NextRequest,{params}:{params:Promise<{linkId:string}>}){return guestHubHouseRulesPublicHttp(request,{db:prisma},(await params).linkId,"view");}
