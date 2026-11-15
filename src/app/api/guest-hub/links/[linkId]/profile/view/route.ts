import type {NextRequest} from "next/server";
import {prisma} from "@/platform/db/client";
import {guestHubProfilePublicHttp} from "@/modules/guest-hub/ui/guest-hub-profile-public-http";
export async function POST(request:NextRequest,{params}:{params:Promise<{linkId:string}>}){return guestHubProfilePublicHttp(request,{db:prisma},(await params).linkId,"view");}
