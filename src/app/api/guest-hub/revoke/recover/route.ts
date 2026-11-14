import type {NextRequest} from "next/server";
import {prisma} from "@/platform/db/client";
import {guestHubStaffHttp} from "@/modules/guest-hub/ui/guest-hub-http";
import {recoverGuestHubRevocation} from "@/modules/guest-hub/application/guest-hub-service";
export async function POST(request:NextRequest){return guestHubStaffHttp(request,(actor,input,requestId)=>recoverGuestHubRevocation(actor,input,{db:prisma,requestId}));}
