import { financialAttachmentMaximumBytes } from "@/modules/finance/domain/financial-attachment-parts";

export const storageFixtureEnvironment = { R2_ACCOUNT_ID: "alvillas-e2e-local", R2_BUCKET: "private-e2e-evidence", R2_ACCESS_KEY_ID: "local-e2e-access", R2_SECRET_ACCESS_KEY: "local-e2e-signing-fixture",
  ALVILLAS_E2E_STORAGE_MAX_OBJECT_BYTES: String(financialAttachmentMaximumBytes + 256) };
