import type {NextRequest} from "next/server";
import {prisma} from "@/platform/db/client";
import {guestHubStaffHttp} from "@/modules/guest-hub/ui/guest-hub-http";
import {reviewGuestHubIssue} from "@/modules/guest-hub/application/guest-hub-service";
export async function POST(request:NextRequest){return guestHubStaffHttp(request,(actor,input,requestId)=>reviewGuestHubIssue(actor,input,{db:prisma,requestId}));}
