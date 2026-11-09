import type {NextRequest} from "next/server";
import {prisma} from "@/platform/db/client";
import {onboardingHttp} from "@/modules/onboarding/ui/onboarding-http";
import {readOnboardingDirectory} from "@/modules/onboarding/application/onboarding-service";
export async function POST(request:NextRequest){return onboardingHttp(request,(actor,input,requestId)=>readOnboardingDirectory(actor,input,{db:prisma,requestId}));}
