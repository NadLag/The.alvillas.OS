import type {NextRequest} from "next/server";
import {prisma} from "@/platform/db/client";
import {nativeGuestIdentityCaptureHttp} from "@/app/api/guest-hub/identity-documents/native-document-http";
export async function POST(request:NextRequest,{params}:{params:Promise<{linkId:string}>}){return nativeGuestIdentityCaptureHttp(request,{db:prisma},(await params).linkId,"view");}
