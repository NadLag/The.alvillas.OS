import type {NextRequest} from "next/server";
import {prisma} from "@/platform/db/client";
import {onboardingHttp} from "@/modules/onboarding/ui/onboarding-http";
import {readOnboardingActivationStatus} from "@/modules/onboarding/application/onboarding-activation-status-service";

export async function POST(request:NextRequest){return onboardingHttp(request,(actor,input,requestId)=>readOnboardingActivationStatus(actor,input,{db:prisma,requestId}));}
