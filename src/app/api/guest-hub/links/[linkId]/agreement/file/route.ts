import type {NextRequest} from "next/server";
import {prisma} from "@/platform/db/client";
import {configuredDocumentObjects} from "@/modules/documents/application/document-files";
import {guestHubAgreementFileHttp} from "@/modules/guest-hub/ui/guest-hub-agreement-file-http";
import {downloadNativeGuestAgreement} from "@/app/api/guest-hub/agreement/native-document-download";
import {nativeGuestAgreementDocumentAuthority} from "@/app/api/guest-hub/agreement/native-document-authority";
export const runtime="nodejs";
export async function POST(request:NextRequest,{params}:{params:Promise<{linkId:string}>}){return guestHubAgreementFileHttp(request,{db:prisma,agreementDocuments:nativeGuestAgreementDocumentAuthority},(await params).linkId,(capability,input,context)=>downloadNativeGuestAgreement(capability,input,{...context,objects:configuredDocumentObjects()}));}
