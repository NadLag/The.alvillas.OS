import {
  FEATURE_ID_PATTERN,
  parseFeatureIdLock,
  parseProgress,
  PROGRESS_STATUS_VALUES,
  readText,
  validateProgressAgainstLock
} from "./progress-lib";
import { writeFileSync } from "node:fs";

const [id, status, ...noteParts] = process.argv.slice(2);
const note = noteParts.join(" ").trim();

if (!id || !FEATURE_ID_PATTERN.test(id)) {
  throw new Error("Usage: set-progress-note <feature-id> <status> <note>");
}

if (!(PROGRESS_STATUS_VALUES as readonly string[]).includes(status)) {
  throw new Error(`Status must be one of: ${PROGRESS_STATUS_VALUES.join(", ")}`);
}

if (!note) {
  throw new Error("Progress note is required");
}

const progressPath = "PROGRESS.md";
const originalProgress = readText(progressPath);
const escapedId = id.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
const rowPattern = new RegExp(
  `^${escapedId} \\| (DONE|IN-PROGRESS|TODO)(?: [^|]*)? \\|.*$`,
  "mu"
);

if (!rowPattern.test(originalProgress)) {
  throw new Error(`Could not find PROGRESS.md row for ${id}`);
}

const updatedProgress = originalProgress.replace(rowPattern, `${id} | ${status} | ${note}`);

writeFileSync(progressPath, updatedProgress);

const locked = parseFeatureIdLock(readText("docs/FEATURE_IDS.lock"));
const progress = parseProgress(updatedProgress);
const failures = validateProgressAgainstLock(
  locked.ids,
  progress.rows,
  locked.invalidLines,
  progress.malformedRows
);

if (failures.length > 0) {
  writeFileSync(progressPath, originalProgress);
  console.error(failures.join("\n\n"));
  process.exit(1);
}

console.log(`updated ${id} as ${status}`);
