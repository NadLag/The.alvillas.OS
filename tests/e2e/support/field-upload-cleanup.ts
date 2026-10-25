import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { withTenant } from "@/platform/db/tenant";
import { cleanupFieldUploadParts } from "@/modules/reservations/application/field-upload-cleanup";

// Run the real application maintenance path in its normal TS runtime, outside
// Playwright's browser-test module loader. This fixture has no issued signatures
// or temporary objects; provider deletion of missing parts is idempotent.
const database = new URL(z.string().parse(process.env.DATABASE_URL));
if (process.env.VERCEL || process.env.VERCEL_ENV || !["localhost", "127.0.0.1"].includes(database.hostname)) throw Error("Isolated local recovery fixture required");
const input = z.object({ organizationId: z.uuid(), uploadId: z.uuid() }).strict().parse(JSON.parse(readFileSync(0, "utf8")));
const db = new PrismaClient(), deletedIndices: number[] = [];
try {
  const before = await withTenant(db, input.organizationId, tx => tx.operationEvidenceUpload.findUniqueOrThrow({ where: { id: input.uploadId } }));
  if (before.status !== "CANCELLED" || before.cleanedAt || before.partUploadExpiresAt) throw Error("Historical unsigned expired transport fixture required");
  const result = await cleanupFieldUploadParts(input.organizationId, { db, limit: 1, storage: { deleteTemporaryUploadPart: part => {
    if (part.uploadId !== input.uploadId || part.organizationId !== input.organizationId || part.generation !== undefined) throw Error("Unexpected recovery fixture transport");
    deletedIndices.push(part.index); return Promise.resolve();
  } } });
  const after = await withTenant(db, input.organizationId, tx => tx.operationEvidenceUpload.findUniqueOrThrow({ where: { id: input.uploadId } }));
  if (result.cleaned !== 1 || !after.cleanedAt || after.status !== "CANCELLED") throw Error("Actual maintenance cleanup marker required");
  process.stdout.write(JSON.stringify({ ...result, deletedIndices }));
} finally { await db.$disconnect(); }
