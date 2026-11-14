import type {NextRequest} from "next/server";
import {prisma} from "@/platform/db/client";
import {guestHubStayDetailsPublicHttp} from "@/modules/guest-hub/ui/guest-hub-stay-details-public-http";
export async function POST(request:NextRequest,{params}:{params:Promise<{linkId:string}>}){return guestHubStayDetailsPublicHttp(request,{db:prisma},(await params).linkId,"recover");}
