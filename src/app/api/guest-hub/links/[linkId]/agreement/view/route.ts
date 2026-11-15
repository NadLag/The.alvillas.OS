import type {NextRequest} from "next/server";
import {prisma} from "@/platform/db/client";
import {guestHubAgreementPublicHttp} from "@/modules/guest-hub/ui/guest-hub-agreement-public-http";
import {nativeGuestAgreementDocumentAuthority} from "@/app/api/guest-hub/agreement/native-document-authority";
export const runtime="nodejs";
export async function POST(request:NextRequest,{params}:{params:Promise<{linkId:string}>}){return guestHubAgreementPublicHttp(request,{db:prisma,agreementDocuments:nativeGuestAgreementDocumentAuthority},(await params).linkId,"view");}
