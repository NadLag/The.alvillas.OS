import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const root = process.cwd();
const failures: string[] = [];
const physicalDirectionalPattern =
  /(?:^|[{\s;])(?:(?:margin|padding|border)-(?:left|right)\b|(?:left|right)\s*:|text-align\s*:\s*(?:left|right))/gimu;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

function normalized(path: string): string {
  return relative(root, path).split(sep).join("/");
}

for (const file of walk(join(root, "src")).filter((path) => path.endsWith(".css"))) {
  const source = readFileSync(file, "utf8");
  const matches = source.match(physicalDirectionalPattern);

  if (matches) {
    failures.push(`${normalized(file)} uses physical directional CSS: ${matches.join(", ")}`);
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log("rtl css check ok");
