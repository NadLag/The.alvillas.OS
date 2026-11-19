import http from "k6/http";
import { check, fail } from "k6";
import { Trend } from "k6/metrics";

const profiles = {
  "10": { reads: 2, reports: 1, fieldPulls: 2 },
  "100": { reads: 10, reports: 2, fieldPulls: 10 },
  "500": { reads: 40, reports: 5, fieldPulls: 40 }
};
const staging = "https://the-alvillas-os-staging.vercel.app";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const day = /^\d{4}-\d{2}-\d{2}$/;
const sha = /^[0-9a-f]{40}$/;
const origin = __ENV.ALVILLAS_LOAD_TARGET ?? "";
const profile = __ENV.ALVILLAS_LOAD_PROFILE ?? "";
const rates = Object.hasOwn(profiles, profile) ? profiles[profile] : null;
const local = /^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(origin);
const approved = origin === staging && Boolean(__ENV.ALVILLAS_LOAD_APPROVAL_REFERENCE?.trim());
if (!local && !approved) throw new Error("Use a loopback fixture or explicitly approved ALVILLAS staging target.");
if (!rates) throw new Error("Select the approved 10, 100 or 500 property profile.");

const dataset = JSON.parse(open(__ENV.ALVILLAS_LOAD_DATASET_FILE));
const minimumReservations = Number(profile) * 30 * 60;
if (dataset.profile !== profile || dataset.properties !== Number(profile)
  || !Number.isSafeInteger(dataset.reservations) || dataset.reservations < minimumReservations
  || !Number.isSafeInteger(dataset.postings) || dataset.postings < minimumReservations * 50
  || !uuid.test(dataset.organizationId) || !sha.test(dataset.revision)
  || !day.test(dataset.reportFrom) || !day.test(dataset.throughOn) || dataset.reportFrom > dataset.throughOn
  || dataset.revision !== __ENV.ALVILLAS_LOAD_EXPECTED_SHA) {
  throw new Error("Supply the verified fixture dataset for the expected application revision.");
}

const administrator = __ENV.ALVILLAS_LOAD_ADMIN_COOKIE ?? "";
const field = __ENV.ALVILLAS_LOAD_FIELD_COOKIE ?? "";
const fieldAccount = __ENV.ALVILLAS_LOAD_FIELD_ACCOUNT_ID ?? "";
if (!administrator.trim() || !field.trim() || /[\r\n]/.test(administrator + field) || !uuid.test(fieldAccount)) {
  throw new Error("Fixture administrator and field sessions are required.");
}

const durations = {
  directory: new Trend("property_directory_ms", true),
  report: new Trend("company_report_ms", true),
  field: new Trend("field_sync_pull_ms", true)
};
const reportPath = `/en/app/reports/company?fromOn=${dataset.reportFrom}&toOn=${dataset.throughOn}`;
const fieldPath = `/api/sync/pull?organization_id=${dataset.organizationId}&actor_user_id=${fieldAccount}&mode=assigned`;

function scenario(exec, rate) {
  return { executor: "constant-arrival-rate", exec, duration: "90s", rate, timeUnit: "1s",
    preAllocatedVUs: rate, maxVUs: rate * 2 };
}

export const options = {
  maxRedirects: 0,
  systemTags: ["method", "status", "name", "check", "scenario", "expected_response", "error_code"],
  scenarios: {
    property_directory: scenario("propertyDirectory", rates.reads),
    company_report: scenario("companyReport", rates.reports),
    field_sync_pull: scenario("fieldSyncPull", rates.fieldPulls)
  },
  thresholds: {
    checks: ["rate==1"], dropped_iterations: ["count==0"], company_report_ms: ["p(95)<800"],
    ...(profile === "100" ? { property_directory_ms: ["p(95)<300"], field_sync_pull_ms: ["p(95)<300"] } : {})
  }
};

function get(path, name, cookie) {
  const headers = { "Cache-Control": "no-cache" };
  if (cookie) headers.Cookie = cookie;
  if (approved && __ENV.VERCEL_AUTOMATION_BYPASS_SECRET) {
    headers["x-vercel-protection-bypass"] = __ENV.VERCEL_AUTOMATION_BYPASS_SECRET;
  }
  return http.get(origin + path, { headers, tags: { name }, redirects: 0 });
}

function object(response) {
  if (response.status !== 200) return null;
  try { return response.json(); } catch { return null; }
}

function directoryOk(response) {
  return response.status === 200 && typeof response.body === "string" && response.body.includes('data-testid="properties-page"');
}

function reportOk(response) {
  return response.status === 200 && typeof response.body === "string"
    && response.body.includes('data-testid="company-performance-report"')
    && response.body.includes("/app/reports/company/download");
}

function fieldOk(response) {
  const result = object(response);
  return result?.organization_id === dataset.organizationId && result.actor_user_id === fieldAccount
    && result.op_schema_version === 1 && Array.isArray(result.tasks);
}

export function setup() {
  const info = object(get("/api/version", "version"));
  if (info?.service !== "alvillas-os" || info.version !== dataset.revision || (approved && info.environment !== "preview")) {
    fail("Target version does not match the approved fixture.");
  }
  if (!directoryOk(get("/en/app/properties", "property-directory", administrator))
    || !reportOk(get(reportPath, "company-report", administrator))
    || !fieldOk(get(fieldPath, "field-sync-pull", field))) {
    fail("Fixture sessions or required performance surfaces are unavailable.");
  }
}

export function propertyDirectory() {
  const response = get("/en/app/properties", "property-directory", administrator);
  durations.directory.add(response.timings.duration);
  check(response, { "authorized property directory": directoryOk });
}

export function companyReport() {
  const response = get(reportPath, "company-report", administrator);
  durations.report.add(response.timings.duration);
  check(response, { "configured company report": reportOk });
}

export function fieldSyncPull() {
  const response = get(fieldPath, "field-sync-pull", field);
  durations.field.add(response.timings.duration);
  check(response, { "correct field actor and tenant": fieldOk });
}
