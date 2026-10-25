-- Link field issues to the existing immutable task evidence. Existing issues
-- remain intact; the compound foreign key prevents cross-task/tenant linkage.
ALTER TABLE "operation_issue" ADD COLUMN "evidence_id" UUID;
CREATE UNIQUE INDEX "operation_evidence_task_id_unique"
  ON "operation_task_evidence" ("organization_id", "task_id", "id");
ALTER TABLE "operation_issue" ADD CONSTRAINT "operation_issue_evidence_fkey"
  FOREIGN KEY ("organization_id", "task_id", "evidence_id")
  REFERENCES "operation_task_evidence" ("organization_id", "task_id", "id")
  ON DELETE RESTRICT ON UPDATE NO ACTION;
