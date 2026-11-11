import {z} from "zod";

/** Shared with the canonical configuration writer; references retain the exact stored key. */
export const configRuleKeyInputSchema=z.string().trim().min(1).max(160);
