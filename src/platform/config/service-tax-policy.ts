import {z} from "zod";

/** Reuses the original finance.tax amount/rate fields; service assessment never infers a treatment. */
export const serviceTaxAssessmentConfigSchema=z.object({basis:z.literal("ACTUAL_COLLECTED_GROSS"),method:z.enum(["FIXED","BASIS_POINTS"]),rounding:z.literal("HALF_UP_AT_LEDGER_PRECISION")}).strict();
