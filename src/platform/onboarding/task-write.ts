import {createOperationTask} from "@/modules/reservations/application/operation-service";
import {ReservationAuthorizationError,ReservationConflictError,ReservationConfigError,ReservationNotFoundError} from "@/modules/reservations/application/reservation-service";
import {OnboardingAccessError,OnboardingConflictError,OnboardingConfigurationError} from "@/modules/onboarding/domain/onboarding-wizard";

/** The canonical task service owns creation, idempotency, configured checklists, audit and outbox. */
export async function createOnboardingTask(actor:Parameters<typeof createOperationTask>[0],input:unknown,deps:Parameters<typeof createOperationTask>[2]){
 try{return await createOperationTask(actor,input,deps);}catch(error){if(error instanceof ReservationAuthorizationError)throw new OnboardingAccessError();if(error instanceof ReservationConflictError||error instanceof ReservationNotFoundError)throw new OnboardingConflictError();if(error instanceof ReservationConfigError)throw new OnboardingConfigurationError();throw error;}
}
