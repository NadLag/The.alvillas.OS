import console from "node:console";
import process from "node:process";
import { readFileSync } from "node:fs";

const reports = process.argv.slice(2);
if (reports.length === 0) {
  console.error("Pass a Lighthouse mobile JSON report for each public homepage locale.");
  process.exit(1);
}

for (const file of reports) {
  const report = JSON.parse(readFileSync(file, "utf8"));
  const scores = Object.fromEntries(["performance", "accessibility", "seo"].map(category => [
    category, report.categories?.[category]?.score
  ]));
  const largestPaint = report.audits?.["largest-contentful-paint"]?.numericValue;
  const layoutShift = report.audits?.["cumulative-layout-shift"]?.numericValue;
  console.log(JSON.stringify({ url: report.finalDisplayedUrl, scores, largestPaint, layoutShift }));
  if (report.runtimeError || report.configSettings?.formFactor !== "mobile" ||
    Object.values(scores).some(score => typeof score !== "number" || score < 0.9) ||
    typeof largestPaint !== "number" || largestPaint >= 2500 ||
    typeof layoutShift !== "number" || layoutShift >= 0.1) {
    process.exitCode = 1;
  }
}
