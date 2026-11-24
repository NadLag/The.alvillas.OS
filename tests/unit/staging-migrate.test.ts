import { describe, expect, it } from "vitest";
import { assertStagingMigrationTarget, stagingDatabaseIdentity } from "../../scripts/staging-migrate";
import { compareStagingHistory, type StagingHistoryRow } from "../../scripts/staging-history-repository";

const databaseUrl = "postgresql://migration:private@preview-db.example.test/alvillas?schema=public";
const approved: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  GITHUB_REPOSITORY: "NadLag/The.alvillas.OS", GITHUB_REF: "refs/heads/main", GITHUB_SHA: "a".repeat(40),
  VERCEL_PROJECT_ID: "prj_GJBdVD7r7fBkG7vH9rn2K2eLwobC", VERCEL_ORG_ID: "team_tVCdcmsKYxqXHGybrNlB0CGS",
  STAGING_MIGRATION_DATABASE_URL: databaseUrl, STAGING_DATABASE_IDENTITY: stagingDatabaseIdentity(databaseUrl)
};

describe("staging migration target guard", () => {
  it("accepts only the approved preview database and treats its pooler as the same database", () => {
    expect(assertStagingMigrationTarget(approved)).toBe(databaseUrl);
    expect(stagingDatabaseIdentity(databaseUrl.replace("preview-db.", "preview-db-pooler."))).toBe(approved.STAGING_DATABASE_IDENTITY);
  });
  it.each([
    { GITHUB_REPOSITORY: "other/product" }, { GITHUB_REF: "refs/heads/feature" }, { GITHUB_SHA: "main" },
    { VERCEL_PROJECT_ID: "another-project" }, { VERCEL_ORG_ID: "another-team" },
    { STAGING_MIGRATION_DATABASE_URL: databaseUrl.replace("preview-db", "production-db") },
    { STAGING_MIGRATION_DATABASE_URL: databaseUrl.replace("/alvillas?", "/other?") },
    { STAGING_MIGRATION_DATABASE_URL: "" }, { STAGING_DATABASE_IDENTITY: "" }
  ])("rejects an unapproved deployment or database: %j", (override) => {
    expect(() => assertStagingMigrationTarget({ ...approved, ...override })).toThrow();
  });
  it("does not expose invalid connection strings in errors", () => {
    const invalid = "private-password-is-not-a-url";
    expect(() => stagingDatabaseIdentity(invalid)).toThrow("Invalid staging database URL");
    try { stagingDatabaseIdentity(invalid); } catch (error) { expect(String(error)).not.toContain(invalid); }
  });
});

describe("original staging history verification", () => {
  it("allows new records and detects changed or missing original records", () => {
    const original: StagingHistoryRow[] = [
      { source: "_prisma_migrations", id: "migration", digest: "same" },
      { source: "audit_log", id: "audit", digest: "same" },
      { source: "financial_transaction", id: "journal", digest: "same" },
      { source: "posting", id: "posting", digest: "same" }
    ];
    const current: StagingHistoryRow[] = [
      ...original.slice(0, 2),
      { source: "financial_transaction", id: "journal", digest: "changed" },
      { source: "posting", id: "new-posting", digest: "new" }
    ];
    expect(compareStagingHistory(original, current)).toEqual([
      { table: "_prisma_migrations", original: 1, changed: 0 },
      { table: "audit_log", original: 1, changed: 0 },
      { table: "financial_transaction", original: 1, changed: 1 },
      { table: "posting", original: 1, changed: 1 }
    ]);
  });
});
