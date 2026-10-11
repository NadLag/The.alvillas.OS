import { execFileSync } from "node:child_process";

const adminEmail = process.env.ADMIN_EMAIL ?? "admin@example.test";
const adminPassword = process.env.ADMIN_PASSWORD ?? "correct horse battery staple";

function runNpx(args: string[], env: NodeJS.ProcessEnv): void {
  const command = process.platform === "win32" ? "cmd.exe" : "npx";
  const commandArgs = process.platform === "win32" ? ["/d", "/s", "/c", "npx.cmd", ...args] : args;

  execFileSync(command, commandArgs, {
    env,
    stdio: "inherit"
  });
}

export default function globalSetup(): void {
  if (!process.env.DATABASE_URL) {
    return;
  }

  const env = {
    ...process.env,
    ADMIN_EMAIL: adminEmail,
    ADMIN_PASSWORD: adminPassword
  };

  runNpx(["prisma", "migrate", "deploy"], env);
  runNpx(["tsx", "prisma/bootstrap-admin.ts"], env);
}
