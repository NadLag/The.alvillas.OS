import type {NextRequest} from "next/server";
import {prisma} from "@/platform/db/client";
import {guestHubPublicHttp} from "@/modules/guest-hub/ui/guest-hub-public-http";
export async function POST(request:NextRequest){return guestHubPublicHttp(request,{db:prisma});}
