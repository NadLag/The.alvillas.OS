import type {NextRequest} from "next/server";
import {prisma} from "@/platform/db/client";
import {guestHubPublicHttp} from "@/modules/guest-hub/ui/guest-hub-public-http";
export async function POST(request:NextRequest,{params}:{params:Promise<{linkId:string}>}){return guestHubPublicHttp(request,{db:prisma},(await params).linkId);}
