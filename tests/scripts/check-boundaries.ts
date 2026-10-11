import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const root = process.cwd();
const srcRoot = join(root, "src");
const failures: string[] = [];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

function normalized(path: string): string {
  return relative(root, path).split(sep).join("/");
}

for (const file of walk(srcRoot).filter((path) => /\.(ts|tsx)$/u.test(path))) {
  const rel = normalized(file);
  const source = readFileSync(file, "utf8");
  const imports = [...source.matchAll(/from\s+["']([^"']+)["']/gu)].map((match) => match[1]);

  if (/^src\/app\//u.test(rel)) {
    for (const specifier of imports) {
      if (specifier.includes("/infrastructure/")) {
        failures.push(`${rel} imports infrastructure directly: ${specifier}`);
      }
    }
  }

  const moduleMatch = rel.match(/^src\/modules\/([^/]+)\/(.+)$/u);
  if (!moduleMatch) {
    continue;
  }

  const [, moduleName, rest] = moduleMatch;

  for (const specifier of imports) {
    const crossModuleImport = specifier.match(/^@\/modules\/([^/]+)\//u);
    if (crossModuleImport && crossModuleImport[1] !== moduleName) {
      failures.push(`${rel} imports another module directly: ${specifier}`);
    }

    if (rest.startsWith("domain/") && specifier.includes("/infrastructure/")) {
      failures.push(`${rel} domain imports infrastructure: ${specifier}`);
    }

    if (rest.startsWith("application/") && specifier.includes("/ui/")) {
      failures.push(`${rel} application imports UI: ${specifier}`);
    }
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log("layer boundary check ok");
