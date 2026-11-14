import type {NextRequest} from "next/server";
import {prisma} from "@/platform/db/client";
import {onboardingHttp} from "@/modules/onboarding/ui/onboarding-http";
import {readOnboardingReadiness} from "@/modules/onboarding/application/onboarding-readiness-service";

export async function POST(request:NextRequest){return onboardingHttp(request,(actor,input,requestId)=>readOnboardingReadiness(actor,input,{db:prisma,requestId}));}
