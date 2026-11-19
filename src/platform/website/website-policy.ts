import { z } from "zod";

export const websiteAnalyticsPolicyKey = "website.analytics";

export const websiteAnalyticsPolicySchema = z.object({
  enabled: z.boolean(),
  approval_reference: z.string().trim().min(1).max(240),
  window_seconds: z.number().int().positive().max(86400),
  maximum_events: z.number().int().positive().max(2147483647)
}).strict();
