import type {NextRequest} from "next/server";
import {prisma} from "@/platform/db/client";
import {guestHubStaffHttp} from "@/modules/guest-hub/ui/guest-hub-http";
import {reviewGuestHubProfileGrant} from "@/modules/guest-hub/application/guest-hub-profile-grants";
export async function POST(request:NextRequest){return guestHubStaffHttp(request,(actor,input,requestId)=>reviewGuestHubProfileGrant(actor,input,{db:prisma,requestId}));}
