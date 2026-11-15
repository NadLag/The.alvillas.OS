import type {NextRequest} from "next/server";
import {prisma} from "@/platform/db/client";
import {guestHubStaffHttp} from "@/modules/guest-hub/ui/guest-hub-http";
import {nativeGuestIdentityGrants} from "../../native-document-services";
export async function POST(request:NextRequest){return guestHubStaffHttp(request,(actor,input,requestId)=>nativeGuestIdentityGrants.status(actor,input,{db:prisma,requestId}));}
