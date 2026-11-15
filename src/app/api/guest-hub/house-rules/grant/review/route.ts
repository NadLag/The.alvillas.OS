import type {NextRequest} from "next/server";
import {prisma} from "@/platform/db/client";
import {guestHubStaffHttp} from "@/modules/guest-hub/ui/guest-hub-http";
import {reviewGuestHubHouseRulesGrant} from "@/modules/guest-hub/application/guest-hub-house-rules-grants";
export async function POST(request:NextRequest){return guestHubStaffHttp(request,(actor,input,requestId)=>reviewGuestHubHouseRulesGrant(actor,input,{db:prisma,requestId}));}
