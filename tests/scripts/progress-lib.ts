import { readFileSync } from "node:fs";

export const EXPECTED_FEATURE_ID_COUNT = 355;
export const FEATURE_ID_PATTERN = /^F-[A-Z0-9]+-\d{2}$/u;
export const PROGRESS_STATUS_VALUES = ["DONE", "IN-PROGRESS", "TODO"] as const;

export type ProgressStatus = (typeof PROGRESS_STATUS_VALUES)[number];

export type ProgressRow = {
  id: string;
  status: ProgressStatus;
  lineNumber: number;
};

export type ParsedFeatureIds = {
  ids: string[];
  invalidLines: string[];
};

export type ParsedProgress = {
  rows: ProgressRow[];
  malformedRows: string[];
};

export function readText(path: string): string {
  return readFileSync(path, "utf8");
}

export function parseFeatureIdLock(text: string): ParsedFeatureIds {
  const ids: string[] = [];
  const invalidLines: string[] = [];

  text.split(/\r?\n/u).forEach((line, index) => {
    const trimmed = line.trim();

    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      return;
    }

    if (!FEATURE_ID_PATTERN.test(trimmed)) {
      invalidLines.push(`${index + 1}: ${line}`);
      return;
    }

    ids.push(trimmed);
  });

  return { ids, invalidLines };
}

export function parseProgress(text: string): ParsedProgress {
  const rows: ProgressRow[] = [];
  const malformedRows: string[] = [];
  const progressRowPattern =
    /^\s*(F-[A-Z0-9]+-\d{2})\s+\|\s+(DONE|IN-PROGRESS|TODO)(?:\s|\|)/u;

  text.split(/\r?\n/u).forEach((line, index) => {
    const match = line.match(progressRowPattern);

    if (match) {
      rows.push({
        id: match[1],
        status: match[2] as ProgressStatus,
        lineNumber: index + 1
      });
      return;
    }

    if (/^\s*F-/u.test(line)) {
      malformedRows.push(`${index + 1}: ${line}`);
    }
  });

  return { rows, malformedRows };
}

export function findDuplicates(values: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();

  for (const value of values) {
    if (seen.has(value)) {
      duplicates.add(value);
      continue;
    }

    seen.add(value);
  }

  return [...duplicates].sort();
}

export function validateProgressAgainstLock(
  lockedIds: string[],
  progressRows: ProgressRow[],
  invalidLockLines: string[],
  malformedProgressRows: string[]
): string[] {
  const failures: string[] = [];
  const lockedSet = new Set(lockedIds);
  const progressIds = progressRows.map((row) => row.id);
  const progressSet = new Set(progressIds);
  const duplicateLockedIds = findDuplicates(lockedIds);
  const duplicateProgressIds = findDuplicates(progressIds);

  if (invalidLockLines.length > 0) {
    failures.push(
      `docs/FEATURE_IDS.lock contains invalid feature ID lines:\n${invalidLockLines.join("\n")}`
    );
  }

  if (malformedProgressRows.length > 0) {
    failures.push(
      `PROGRESS.md contains malformed feature rows:\n${malformedProgressRows.join("\n")}`
    );
  }

  if (lockedIds.length !== EXPECTED_FEATURE_ID_COUNT) {
    failures.push(
      `docs/FEATURE_IDS.lock contains ${lockedIds.length} feature IDs; expected ${EXPECTED_FEATURE_ID_COUNT}`
    );
  }

  if (lockedSet.size !== EXPECTED_FEATURE_ID_COUNT) {
    failures.push(
      `docs/FEATURE_IDS.lock contains ${lockedSet.size} unique feature IDs; expected ${EXPECTED_FEATURE_ID_COUNT}`
    );
  }

  if (duplicateLockedIds.length > 0) {
    failures.push(`docs/FEATURE_IDS.lock duplicates: ${duplicateLockedIds.join(", ")}`);
  }

  if (progressRows.length !== EXPECTED_FEATURE_ID_COUNT) {
    failures.push(
      `PROGRESS.md contains ${progressRows.length} feature rows; expected ${EXPECTED_FEATURE_ID_COUNT}`
    );
  }

  if (progressSet.size !== EXPECTED_FEATURE_ID_COUNT) {
    failures.push(
      `PROGRESS.md contains ${progressSet.size} unique feature IDs; expected ${EXPECTED_FEATURE_ID_COUNT}`
    );
  }

  if (duplicateProgressIds.length > 0) {
    failures.push(`PROGRESS.md duplicates: ${duplicateProgressIds.join(", ")}`);
  }

  const missingIds = lockedIds.filter((id) => !progressSet.has(id));
  const extraIds = progressIds.filter((id) => !lockedSet.has(id));

  if (missingIds.length > 0) {
    failures.push(`PROGRESS.md missing locked IDs: ${missingIds.join(", ")}`);
  }

  if (extraIds.length > 0) {
    failures.push(`PROGRESS.md has IDs not in lock: ${extraIds.join(", ")}`);
  }

  return failures;
}

export function moduleFromFeatureId(id: string): string {
  const [, module] = id.split("-");

  return module;
}
