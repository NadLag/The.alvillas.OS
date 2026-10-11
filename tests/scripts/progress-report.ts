import {
  moduleFromFeatureId,
  parseFeatureIdLock,
  parseProgress,
  PROGRESS_STATUS_VALUES,
  readText,
  validateProgressAgainstLock
} from "./progress-lib";
import type { ProgressStatus } from "./progress-lib";

type Totals = Record<ProgressStatus, number>;

type PhaseDefinition = {
  key: string;
  name: string;
  modules: string[];
};

const phases: PhaseDefinition[] = [
  { key: "P0", name: "Foundation and live skeleton", modules: ["FND"] },
  {
    key: "P1",
    name: "Identity, authorization, audit, i18n, design system",
    modules: ["IDN", "AUZ", "AUD", "I18", "DSN", "NTF"]
  },
  {
    key: "P2",
    name: "Core domain and configuration",
    modules: ["CFG", "ORG", "TPL", "TEM"]
  },
  { key: "P3", name: "Reservations to operations", modules: ["RES", "OPS", "AUT"] },
  { key: "P4", name: "Field app", modules: ["FLD"] },
  { key: "P5", name: "Financial engine", modules: ["FIN"] },
  { key: "P6", name: "Documents, CRM, onboarding", modules: ["DOC", "CRM", "ONB"] },
  { key: "P7", name: "Guest Hub and services", modules: ["GST", "SVC"] },
  {
    key: "P8",
    name: "Inventory, laundry, maintenance, assets, suppliers",
    modules: ["INV", "LND", "MNT", "AST", "SUP"]
  },
  { key: "P9", name: "Owner portal", modules: ["OWN"] },
  { key: "P10", name: "Reports, KPIs, Command Center", modules: ["RPT", "CMD"] },
  { key: "P11", name: "Public website", modules: ["WEB"] },
  { key: "P12", name: "Personal OS", modules: ["PER"] },
  { key: "P13", name: "Hardening, Golden Path, migration, launch", modules: ["SEC", "PRF", "OPR", "DRC", "QA"] }
];

function emptyTotals(): Totals {
  return { DONE: 0, "IN-PROGRESS": 0, TODO: 0 };
}

function addStatus(totals: Totals, status: ProgressStatus): void {
  totals[status] += 1;
}

function addTotals(target: Totals, source: Totals): void {
  for (const status of PROGRESS_STATUS_VALUES) {
    target[status] += source[status];
  }
}

function gateStatus(totals: Totals): ProgressStatus {
  if (totals.TODO === 0 && totals["IN-PROGRESS"] === 0) {
    return "DONE";
  }

  if (totals.DONE > 0 || totals["IN-PROGRESS"] > 0) {
    return "IN-PROGRESS";
  }

  return "TODO";
}

function printTotals(label: string, totals: Totals, suffix = ""): void {
  console.log(
    `${label} | DONE ${totals.DONE} | IN-PROGRESS ${totals["IN-PROGRESS"]} | TODO ${totals.TODO}${suffix}`
  );
}

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

const progressById = new Map(progress.rows.map((row) => [row.id, row.status]));
const moduleTotals = new Map<string, Totals>();
const moduleOrder: string[] = [];

for (const id of locked.ids) {
  const module = moduleFromFeatureId(id);
  const status = progressById.get(id);

  if (!status) {
    throw new Error(`Missing progress row for ${id}`);
  }

  if (!moduleTotals.has(module)) {
    moduleTotals.set(module, emptyTotals());
    moduleOrder.push(module);
  }

  addStatus(moduleTotals.get(module)!, status);
}

console.log(`Progress report (${locked.ids.length} locked feature IDs)`);
console.log("");
console.log("Per module");

for (const module of moduleOrder) {
  printTotals(module, moduleTotals.get(module)!);
}

console.log("");
console.log("Per phase and gates");

for (const phase of phases) {
  const totals = emptyTotals();

  for (const module of phase.modules) {
    const moduleTotal = moduleTotals.get(module);

    if (moduleTotal) {
      addTotals(totals, moduleTotal);
    }
  }

  printTotals(`${phase.key} ${phase.name} [${phase.modules.join(", ")}]`, totals, ` | gate ${gateStatus(totals)}`);
}
