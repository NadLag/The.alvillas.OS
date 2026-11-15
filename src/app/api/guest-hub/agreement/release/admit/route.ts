import type {NextRequest} from "next/server";
import {prisma} from "@/platform/db/client";
import {guestHubStaffHttp} from "@/modules/guest-hub/ui/guest-hub-http";
import {recordGuestHubAgreementRelease} from "@/modules/guest-hub/application/guest-hub-agreement-releases";
import {nativeGuestAgreementDocumentAuthority} from "@/app/api/guest-hub/agreement/native-document-authority";
export const runtime="nodejs";
export async function POST(request:NextRequest){return guestHubStaffHttp(request,(actor,input,requestId)=>recordGuestHubAgreementRelease(actor,input,{db:prisma,requestId,agreementDocuments:nativeGuestAgreementDocumentAuthority}));}
