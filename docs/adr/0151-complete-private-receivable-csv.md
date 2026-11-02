# ADR 0151: Export a complete protected receivable snapshot

Date: 2026-11-02

Status: Accepted

The aging workspace deliberately returns at most 50 claims with an encrypted, actor-bound cursor. Exporting that page would silently omit financial obligations. CSV export therefore reuses the canonical aging query and original assignment/receipt movement functions, with an internal complete-result mode. The public body accepts the existing strict filters and rejects cursors, tenant identity and caller-selected result limits.

An export requires all original receivable, journal and compensation view permissions plus each independent export permission, intersected with current unconditional organization authority. The explicit `finance.receivable_exports` rule selects the current original aging source, CSV format and request/window admission budget. The existing PostgreSQL rate limiter commits admission independently, so a later source failure cannot reset that budget. Source disclosure checks the admitted policy version again.

The complete source is validated before any response bytes become available. Every original claim identity is unique, every assigned/collected/outstanding amount uses `Money`, and complete bucket and report totals must agree with the actual claims. The shared application fence prepares the file, records its attributed reason and source fingerprint, then checks current authority and configuration before returning. Failures roll back the export audit and return no file iterator. Financial rows remain untouched.

The response streams RFC 4180 CSV in bounded chunks with a UTF-8 BOM, localized EN/FR/AR labels, complete snapshot provenance, exact decimal text and a total row. Untrusted text is escaped and spreadsheet-formula prefixes are neutralized; validated numeric columns retain their exact decimal or integer representation. Session, same-origin, bounded-body and private-error handling reuse the existing HTTP boundary. Every response remains private and uncached.

The browser downloads only the requested attachment. It holds the reason and temporary blob URL in memory, aborts on unmount, clears private form state when offline or denied, and rechecks the financial view after an export denial. Existing accessible form styles and configured aging filters are reused. No new SQL migration, financial source implementation, default business rule or financial browser cache is introduced.

Acceptance includes complete multi-page real claims, amounts beyond JavaScript's safe integer range, actual receipts and exact opposite corrections, held/fresh permission intersections, tenant boundaries, durable rate admission after source failure, policy changes, revocation before final disclosure and attributed audit history. Native download checks cover all three locales, desktop/mobile, 360px with 200% text, accessibility, offline clearing and revoked access. Capacity uses all 500 actual property claims in each complete file with the existing two-second HTTP p95 and zero browser retries.
