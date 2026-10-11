import { pathToFileURL } from "node:url";
import { PrismaClient } from "@prisma/client";

export const demoOrganizationId = "018f0a0b-0000-7000-9000-000000000100";

type DemoSeedClient = {
  organization: {
    upsert(args: {
      where: { id: string };
      update: { name: string; baseCurrency: string };
      create: { id: string; name: string; baseCurrency: string };
    }): Promise<unknown>;
  };
};

export function assertDemoSeedAllowed(env: Partial<NodeJS.ProcessEnv> = process.env): void {
  if (env.NODE_ENV === "production" || env.VERCEL_ENV === "production") {
    throw new Error("Demo seed cannot run in production");
  }
}

export async function seedDemoData(client: DemoSeedClient): Promise<void> {
  await client.organization.upsert({
    where: { id: demoOrganizationId },
    update: {
      name: "ALVILLAS Demo",
      baseCurrency: "MAD"
    },
    create: {
      id: demoOrganizationId,
      name: "ALVILLAS Demo",
      baseCurrency: "MAD"
    }
  });
}

async function main(): Promise<void> {
  assertDemoSeedAllowed();
  const prisma = new PrismaClient();

  try {
    await seedDemoData(prisma);
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
