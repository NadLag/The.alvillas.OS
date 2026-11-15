import type {NextRequest} from "next/server";
import {prisma} from "@/platform/db/client";
import {nativeGuestIdentityFileHttp} from "@/app/api/guest-hub/identity-documents/native-document-http";
export async function POST(request:NextRequest,{params}:{params:Promise<{linkId:string;captureId:string;fileId:string;index:string}>}){const actual=await params;return nativeGuestIdentityFileHttp(request,{db:prisma},{linkId:actual.linkId,captureId:actual.captureId,fileId:actual.fileId},"part",actual.index);}
