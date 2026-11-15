import type {NextRequest} from "next/server";
import {prisma} from "@/platform/db/client";
import {guestHubStaffHttp} from "@/modules/guest-hub/ui/guest-hub-http";
import {readGuestHubHouseRulesHistory} from "@/modules/guest-hub/application/guest-hub-house-rules-history";
export async function POST(request:NextRequest){return guestHubStaffHttp(request,(actor,input,requestId)=>readGuestHubHouseRulesHistory(actor,input,{db:prisma,requestId}));}
