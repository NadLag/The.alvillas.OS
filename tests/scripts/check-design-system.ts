import { readFileSync } from "node:fs";
import { join } from "node:path";

const css = readFileSync(join(process.cwd(), "src", "app", "globals.css"), "utf8");
const rootMatch = css.match(/:root\s*\{(?<body>[\s\S]*?)\n\}/u);
const rootBody = rootMatch?.groups?.body ?? "";
const failures: string[] = [];

const requiredTokenGroups = {
  color: [
    "--color-ink-950",
    "--color-green-700",
    "--color-mist-100",
    "--color-rust-700",
    "--surface-canvas",
    "--surface-panel",
    "--surface-raised",
    "--surface-muted",
    "--text-primary",
    "--text-secondary",
    "--accent",
    "--warning"
  ],
  type: [
    "--font-sans",
    "--font-mono",
    "--font-size-xs",
    "--font-size-sm",
    "--font-size-md",
    "--font-size-base",
    "--font-size-lg",
    "--font-size-xl",
    "--font-size-2xl",
    "--font-size-3xl",
    "--font-size-display",
    "--line-height-tight",
    "--line-height-copy",
    "--line-height-roomy",
    "--font-weight-semibold",
    "--font-weight-bold"
  ],
  spacing: [
    "--space-1",
    "--space-2",
    "--space-3",
    "--space-4",
    "--space-5",
    "--space-6",
    "--space-7",
    "--space-8",
    "--space-9",
    "--space-10",
    "--space-11"
  ],
  radius: ["--radius-sm", "--radius-md", "--radius-lg"],
  elevation: ["--shadow-sm", "--shadow-panel", "--shadow-focus"],
  motion: [
    "--motion-duration-fast",
    "--motion-duration-base",
    "--motion-duration-slow",
    "--motion-ease-standard"
  ],
  target: ["--target-compact", "--target-min", "--target-field", "--target-field-large"]
} satisfies Record<string, string[]>;

for (const [group, tokens] of Object.entries(requiredTokenGroups)) {
  for (const token of tokens) {
    if (!rootBody.includes(`${token}:`)) {
      failures.push(`missing ${group} token ${token}`);
    }
  }
}

const legacyAliases = ["--background", "--foreground", "--muted", "--surface", "--border", "--ink-soft"];

for (const token of legacyAliases) {
  if (!rootBody.includes(`${token}: var(`)) {
    failures.push(`${token} must alias a design-system token`);
  }
}

if (/--font-sans:[^;]*(?:Arial|Inter|Roboto)/iu.test(rootBody)) {
  failures.push("--font-sans must use the ALVILLAS humanist stack, not Inter/Roboto/Arial");
}

for (const [token, expected] of [
  ["--motion-duration-fast", "80ms"],
  ["--motion-duration-base", "150ms"],
  ["--motion-duration-slow", "250ms"]
] as const) {
  if (!new RegExp(`${token}:\\s*${expected}\\s*;`, "u").test(rootBody)) {
    failures.push(`${token} must be ${expected}`);
  }
}

const requiredPatterns = [
  [/prefers-reduced-motion/u, "missing reduced-motion media query"],
  [/\.primary-button:where\(:not\(:disabled\)\):hover/u, "missing primary button hover state"],
  [/\.field input:where\(:not\(:disabled\)\):hover/u, "missing field hover state"],
  [/button:disabled/u, "missing disabled state styling"],
  [/box-shadow:\s*var\(--shadow-focus\)/u, "focus state must use the focus shadow token"]
] as const;

for (const [pattern, message] of requiredPatterns) {
  if (!pattern.test(css)) {
    failures.push(message);
  }
}

if (/linear-gradient\s*\(/iu.test(css)) {
  failures.push("gradients are not part of the base DSN token application");
}

if (/font-size\s*:\s*(?:clamp\(|[^;]*vw)/iu.test(css)) {
  failures.push("font sizes must not scale directly with viewport width");
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log("design system token check ok");
