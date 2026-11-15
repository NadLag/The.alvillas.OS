import type {NextRequest} from "next/server";
import {prisma} from "@/platform/db/client";
import {guestHubStaffHttp} from "@/modules/guest-hub/ui/guest-hub-http";
import {recordGuestHubStayDetailsGrant} from "@/modules/guest-hub/application/guest-hub-stay-details-grants";
export async function POST(request:NextRequest){return guestHubStaffHttp(request,(actor,input,requestId)=>recordGuestHubStayDetailsGrant(actor,input,{db:prisma,requestId}));}
