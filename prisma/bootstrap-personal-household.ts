import { z } from "zod";
import { prisma } from "@/platform/db/client";
import { HouseholdRepository } from "@/modules/personal/infrastructure/household-repository";

try {
  const [organizationId, accountId, householdName, stewardName] = z.tuple([
    z.uuid(), z.uuid(), z.string().min(1).max(120), z.string().min(1).max(120)
  ]).parse(process.argv.slice(2));
  const id = await new HouseholdRepository().provision({ organizationId, accountId }, householdName, stewardName);
  console.log(id);
} catch {
  console.error("Provisioning failed. Provide an organization UUID, active account UUID, household name and steward name.");
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
