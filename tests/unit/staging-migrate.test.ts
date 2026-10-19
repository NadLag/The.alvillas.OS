import { describe, expect, it } from "vitest";
import { assertStagingMigrationTarget, stagingDatabaseIdentity } from "../../scripts/staging-migrate";

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
