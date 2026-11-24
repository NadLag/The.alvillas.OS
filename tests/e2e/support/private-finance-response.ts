import { expect } from "@playwright/test";

const privateVaryTokens = [
  "cookie",
  "next-router-prefetch",
  "next-router-segment-prefetch",
  "next-router-state-tree",
  "origin",
  "rsc"
];

export function expectPrivateFinanceResponse(response: { headers(): Record<string, string> }) {
  const headers = response.headers();
  expect(headers["cache-control"]).toBe("private, no-store");
  const vary = (headers.vary ?? "").split(",").map(value => value.trim().toLowerCase());
  // The production server can add Accept-Encoding when negotiating compression.
  expect(vary.filter(token => token !== "accept-encoding").sort()).toEqual(privateVaryTokens);
}
