import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const messagesDir = join(process.cwd(), "messages");
const files = readdirSync(messagesDir)
  .filter((file) => file.endsWith(".json"))
  .sort();

function flattenKeys(value: unknown, prefix = ""): string[] {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
      flattenKeys(child, prefix ? `${prefix}.${key}` : key)
    );
  }

  return [prefix];
}

const catalogs = new Map<string, Set<string>>();

for (const file of files) {
  const raw = readFileSync(join(messagesDir, file), "utf8");
  const parsed = JSON.parse(raw) as unknown;
  catalogs.set(file, new Set(flattenKeys(parsed)));
}

const [referenceFile, referenceKeys] = catalogs.entries().next().value as [string, Set<string>];
const failures: string[] = [];

for (const [file, keys] of catalogs) {
  for (const key of referenceKeys) {
    if (!keys.has(key)) {
      failures.push(`${file} missing ${key} from ${referenceFile}`);
    }
  }

  for (const key of keys) {
    if (!referenceKeys.has(key)) {
      failures.push(`${file} has extra key ${key}`);
    }
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

const humanReadableAttributes = new Set([
  "aria-description",
  "aria-label",
  "alt",
  "placeholder",
  "title"
]);

function listTsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);

    if (entry.isDirectory()) {
      return listTsxFiles(path);
    }

    if (entry.isFile() && path.endsWith(".tsx")) {
      return [path];
    }

    return [];
  });
}

function hasHumanLetters(value: string): boolean {
  return /\p{L}/u.test(value);
}

function normalizedJsxText(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function location(sourceFile: ts.SourceFile, node: ts.Node): string {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));

  return `${sourceFile.fileName}:${line + 1}:${character + 1}`;
}

function checkHardcodedUiText(file: string): string[] {
  const source = readFileSync(file, "utf8");
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const hardcoded: string[] = [];

  function visit(node: ts.Node): void {
    if (ts.isJsxText(node)) {
      const text = normalizedJsxText(node.getText(sourceFile));

      if (text && hasHumanLetters(text)) {
        hardcoded.push(`${location(sourceFile, node)} hardcoded JSX text "${text}"`);
      }
    }

    if (
      ts.isJsxAttribute(node) &&
      humanReadableAttributes.has(node.name.getText(sourceFile)) &&
      node.initializer &&
      ts.isStringLiteral(node.initializer) &&
      hasHumanLetters(node.initializer.text)
    ) {
      hardcoded.push(
        `${location(sourceFile, node)} hardcoded ${node.name.getText(sourceFile)} "${node.initializer.text}"`
      );
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  return hardcoded;
}

const srcDir = join(process.cwd(), "src");
const hardcodedUiTextFailures = statSync(srcDir).isDirectory()
  ? listTsxFiles(srcDir).flatMap(checkHardcodedUiText)
  : [];

if (hardcodedUiTextFailures.length > 0) {
  console.error(hardcodedUiTextFailures.join("\n"));
  process.exit(1);
}

console.log(`i18n key parity ok for ${files.length} catalogs; hardcoded UI text check ok`);
