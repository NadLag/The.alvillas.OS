import { z } from "zod";

const exact = z.string().regex(/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u);
const allocation = z.object({ sourceKey: z.string().min(1), original: exact, allocatedBefore: exact, amount: exact }).strict();
/** The shared persisted evidence contract; original domain measures enforce units and source budgets. */
export const reconciliationEvidenceSnapshotSchema = z.object({
  unit: z.string().min(1), expected: exact, actual: exact, variance: exact, reason: z.string().min(1), varianceAction: z.string().min(1).nullable(),
  allocations: z.object({ expected: z.array(allocation), actual: z.array(allocation) }).strict(),
  evidence: z.array(z.object({ side: z.enum(["EXPECTED", "ACTUAL"]), sourceKey: z.string().min(1), fingerprint: z.string().regex(/^[a-f0-9]{64}$/u) }).strict())
}).strict();
