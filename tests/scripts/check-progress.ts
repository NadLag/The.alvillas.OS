import {
  EXPECTED_FEATURE_ID_COUNT,
  parseFeatureIdLock,
  parseProgress,
  readText,
  validateProgressAgainstLock
} from "./progress-lib";

const locked = parseFeatureIdLock(readText("docs/FEATURE_IDS.lock"));
const progress = parseProgress(readText("PROGRESS.md"));
const failures = validateProgressAgainstLock(
  locked.ids,
  progress.rows,
  locked.invalidLines,
  progress.malformedRows
);

if (failures.length > 0) {
  console.error(failures.join("\n\n"));
  process.exit(1);
}

console.log(`progress parity ok for ${EXPECTED_FEATURE_ID_COUNT} locked feature IDs`);
