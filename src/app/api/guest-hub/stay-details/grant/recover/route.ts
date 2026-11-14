import type {NextRequest} from "next/server";
import {prisma} from "@/platform/db/client";
import {guestHubStaffHttp} from "@/modules/guest-hub/ui/guest-hub-http";
import {recoverGuestHubStayDetailsGrant} from "@/modules/guest-hub/application/guest-hub-stay-details-grants";
export async function POST(request:NextRequest){return guestHubStaffHttp(request,(actor,input,requestId)=>recoverGuestHubStayDetailsGrant(actor,input,{db:prisma,requestId}));}
