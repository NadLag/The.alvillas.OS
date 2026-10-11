import { readFileSync } from "node:fs";

const handbook = readFileSync("ALVILLAS_OS_BUILD_HANDBOOK.md", "utf8");
const progress = readFileSync("PROGRESS.md", "utf8");

const featureLinePattern = /^\s*-\s+F-/u;
const featureIdPattern = /F-[A-Z]+-\d{2}/gu;

const handbookIds = [
  ...new Set(
    handbook
      .split(/\r?\n/u)
      .filter((line) => featureLinePattern.test(line))
      .flatMap((line) => [...line.matchAll(featureIdPattern)].map((match) => match[0]))
  )
];

const progressRows = progress
  .split(/\r?\n/u)
  .map((line) => line.match(/^(F-[A-Z]+-\d{2}) \| (TODO|IN-PROGRESS|DONE)(?: |\|)/u))
  .filter((match): match is RegExpMatchArray => Boolean(match));

const progressIds = progressRows.map((match) => match[1]);
const progressSet = new Set(progressIds);
const failures: string[] = [];

for (const id of handbookIds) {
  if (!progressSet.has(id)) {
    failures.push(`PROGRESS.md missing ${id}`);
  }
}

for (const id of progressIds) {
  if (!handbookIds.includes(id)) {
    failures.push(`PROGRESS.md has unknown feature ${id}`);
  }
}

if (progressIds.length !== progressSet.size) {
  failures.push("PROGRESS.md contains duplicate feature IDs");
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(`progress parity ok for ${progressIds.length} feature IDs`);
