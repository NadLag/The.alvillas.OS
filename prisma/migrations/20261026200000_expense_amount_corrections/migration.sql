BEGIN;
-- AlterTable
ALTER TABLE "expense" ADD COLUMN     "corrects_expense_id" UUID,
ADD COLUMN     "corrects_expense_version" INTEGER;

-- CreateIndex
CREATE INDEX "expense_organization_id_corrects_expense_id_created_at_id_idx" ON "expense"("organization_id", "corrects_expense_id", "created_at", "id");

-- AddForeignKey
ALTER TABLE "expense" ADD CONSTRAINT "expense_organization_id_corrects_expense_id_fkey" FOREIGN KEY ("organization_id", "corrects_expense_id") REFERENCES "expense"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;


ALTER TABLE expense ADD CONSTRAINT expense_correction_source_pair CHECK (
 (corrects_expense_id IS NULL AND corrects_expense_version IS NULL) OR
 (corrects_expense_id IS NOT NULL AND corrects_expense_version IS NOT NULL AND corrects_expense_version>0 AND corrects_expense_id<>id));

CREATE FUNCTION app_expense_correction_source_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE original expense%ROWTYPE;
BEGIN
 IF TG_OP='UPDATE' AND (NEW.corrects_expense_id IS DISTINCT FROM OLD.corrects_expense_id OR NEW.corrects_expense_version IS DISTINCT FROM OLD.corrects_expense_version)
 THEN RAISE EXCEPTION 'expense correction source is immutable'; END IF;
 IF NEW.corrects_expense_id IS NULL THEN RETURN NEW; END IF;
 SELECT * INTO original FROM expense WHERE organization_id=NEW.organization_id AND id=NEW.corrects_expense_id;
 IF original.id IS NULL OR original.transaction_id IS NULL
  OR NEW.property_id IS DISTINCT FROM original.property_id OR NEW.reservation_id IS DISTINCT FROM original.reservation_id
  OR NEW.funding_account_id IS DISTINCT FROM original.funding_account_id OR NEW.currency IS DISTINCT FROM original.currency
  OR NEW.category IS DISTINCT FROM original.category OR NEW.purpose IS DISTINCT FROM original.purpose
  OR NEW.occurred_on IS DISTINCT FROM original.occurred_on OR NEW.amount=original.amount OR NEW.emergency IS DISTINCT FROM false
 THEN RAISE EXCEPTION 'expense correction must preserve its original source facts and revise the amount'; END IF;
 IF TG_OP='INSERT' AND (NEW.state<>'DRAFT' OR NEW.transaction_id IS NOT NULL OR original.state<>'POSTED' OR original.version<>NEW.corrects_expense_version)
 THEN RAISE EXCEPTION 'expense correction requires its current posted source and a new draft'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER expense_correction_source_guard BEFORE INSERT OR UPDATE ON expense
 FOR EACH ROW EXECUTE FUNCTION app_expense_correction_source_guard();

CREATE FUNCTION app_expense_correction_date_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE corrected expense%ROWTYPE; original_submission expense_submission%ROWTYPE; point timestamptz;
BEGIN
 IF NEW.reference !~ '^EXPENSE:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RETURN NEW; END IF;
 SELECT * INTO corrected FROM expense WHERE organization_id=NEW.organization_id AND id=substring(NEW.reference FROM 9)::uuid;
 IF corrected.corrects_expense_id IS NULL THEN RETURN NEW; END IF;
 point:=clock_timestamp();
 SELECT * INTO original_submission FROM expense_submission WHERE organization_id=NEW.organization_id AND expense_id=corrected.corrects_expense_id;
 IF NEW.reverses_transaction_id IS NOT NULL OR NEW.idempotency_key IS DISTINCT FROM 'expense:'||corrected.id||':posted'
  OR NEW.occurred_at<date_trunc('milliseconds',transaction_timestamp()) OR NEW.occurred_at>point
  OR original_submission.id IS NULL OR (original_submission.snapshot->>'timezone') IS NULL
  OR date_trunc('month',NEW.occurred_at AT TIME ZONE (original_submission.snapshot->>'timezone')) IS DISTINCT FROM
    date_trunc('month',point AT TIME ZONE (original_submission.snapshot->>'timezone'))
 THEN RAISE EXCEPTION 'expense correction must create a new journal in the current open period'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER financial_transaction_expense_correction_date BEFORE INSERT ON financial_transaction
 FOR EACH ROW EXECUTE FUNCTION app_expense_correction_date_guard();

CREATE FUNCTION app_assert_expense_correction(expense_uuid uuid,organization_uuid uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE corrected expense%ROWTYPE; original expense%ROWTYPE; submitted expense_submission%ROWTYPE; original_submission expense_submission%ROWTYPE;
 journal financial_transaction%ROWTYPE; reversal financial_transaction%ROWTYPE; original_policies jsonb; corrected_policies jsonb;
BEGIN
 SELECT * INTO corrected FROM expense WHERE organization_id=organization_uuid AND id=expense_uuid;
 IF corrected.corrects_expense_id IS NULL THEN RETURN; END IF;
 SELECT * INTO original FROM expense WHERE organization_id=organization_uuid AND id=corrected.corrects_expense_id;
 SELECT * INTO original_submission FROM expense_submission WHERE organization_id=organization_uuid AND expense_id=original.id;
 SELECT * INTO submitted FROM expense_submission WHERE organization_id=organization_uuid AND expense_id=corrected.id;
 IF original_submission.id IS NULL THEN RAISE EXCEPTION 'expense correction requires its original submission'; END IF;
 IF NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=organization_uuid AND a.resource_type='expense'
   AND a.resource_id=corrected.id AND a.actor_id=corrected.created_by AND a.action='expense.created'
   AND a.after->>'correctsExpenseId'=original.id::text AND (a.after->>'correctsExpenseVersion')::integer=corrected.corrects_expense_version)
  OR NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=organization_uuid AND a.resource_type='financial_transaction'
   AND a.resource_id=original.transaction_id AND a.actor_id=corrected.created_by AND a.action='finance.expense.correction_requested' AND length(btrim(a.reason)) BETWEEN 6 AND 500
   AND a.after->>'originalExpenseId'=original.id::text AND (a.after->>'originalExpenseVersion')::integer=corrected.corrects_expense_version
   AND a.after->>'correctionExpenseId'=corrected.id::text
   AND EXISTS(SELECT 1 FROM audit_log c WHERE c.organization_id=organization_uuid AND c.resource_type='expense' AND c.resource_id=corrected.id
     AND c.action='expense.created' AND c.actor_id=a.actor_id AND c.reason=a.reason))
 THEN RAISE EXCEPTION 'expense correction requires its attributed source and creation audits'; END IF;
 IF submitted.id IS NOT NULL THEN
  SELECT jsonb_agg(jsonb_build_object('ownerId',p->'ownerId','ownerName',p->'ownerName','shareBps',p->'shareBps',
    'allocationRule',p->'allocationRule','approvalRule',p->'approvalRule','configReferences',p->'configReferences') ORDER BY p->>'ownerId')
   INTO original_policies FROM jsonb_array_elements(original_submission.snapshot->'policies') p;
  SELECT jsonb_agg(jsonb_build_object('ownerId',p->'ownerId','ownerName',p->'ownerName','shareBps',p->'shareBps',
    'allocationRule',p->'allocationRule','approvalRule',p->'approvalRule','configReferences',p->'configReferences') ORDER BY p->>'ownerId')
   INTO corrected_policies FROM jsonb_array_elements(submitted.snapshot->'policies') p;
  IF original_policies IS NULL OR corrected_policies IS DISTINCT FROM original_policies
   OR submitted.snapshot->'timezone' IS DISTINCT FROM original_submission.snapshot->'timezone'
   OR submitted.snapshot->'ownershipSnapshotId' IS DISTINCT FROM original_submission.snapshot->'ownershipSnapshotId'
   OR submitted.snapshot->>'correctsExpenseId' IS DISTINCT FROM original.id::text
   OR submitted.snapshot->>'originalSubmissionId' IS DISTINCT FROM original_submission.id::text
  THEN RAISE EXCEPTION 'expense correction must retain its original agreement versions and ownership'; END IF;
 END IF;
 IF corrected.transaction_id IS NULL THEN RETURN; END IF;
 SELECT * INTO journal FROM financial_transaction WHERE organization_id=organization_uuid AND id=corrected.transaction_id;
 SELECT * INTO reversal FROM financial_transaction WHERE organization_id=organization_uuid AND reverses_transaction_id=original.transaction_id;
 IF original.state<>'VOIDED' OR original.version<>corrected.corrects_expense_version+1 OR reversal.id IS NULL
  OR corrected.state NOT IN ('POSTED','VOIDED') OR journal.id IS NULL OR journal.created_by<>reversal.created_by
  OR (SELECT count(*) FROM expense WHERE organization_id=organization_uuid AND corrects_expense_id=original.id AND transaction_id IS NOT NULL)<>1
  OR NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=organization_uuid AND a.resource_type='financial_transaction'
   AND a.resource_id=journal.id AND a.actor_id=journal.created_by AND a.action='finance.expense.correction_posted' AND length(btrim(a.reason)) BETWEEN 6 AND 500
   AND a.after->>'originalExpenseId'=original.id::text AND (a.after->>'originalExpenseVersion')::integer=corrected.corrects_expense_version
   AND a.after->>'originalTransactionId'=original.transaction_id::text AND a.after->>'reversalTransactionId'=reversal.id::text
   AND a.after->>'correctionExpenseId'=corrected.id::text AND a.after->>'transactionId'=journal.id::text AND a.after->>'submissionId'=submitted.id::text
   AND (a.after#>>'{originalAmount,amount}')::numeric=original.amount AND a.after#>>'{originalAmount,currency}'=original.currency
   AND (a.after#>>'{correctedAmount,amount}')::numeric=corrected.amount AND a.after#>>'{correctedAmount,currency}'=corrected.currency
   AND EXISTS(SELECT 1 FROM audit_log p WHERE p.organization_id=organization_uuid AND p.resource_type='expense' AND p.resource_id=corrected.id
     AND p.action='expense.posted' AND p.actor_id=a.actor_id AND p.reason=a.reason)
   AND EXISTS(SELECT 1 FROM audit_log v WHERE v.organization_id=organization_uuid AND v.resource_type='expense' AND v.resource_id=original.id
     AND v.action='expense.voided' AND v.actor_id=a.actor_id AND v.reason=a.reason
     AND (v.before->>'version')::integer=corrected.corrects_expense_version AND v.after->>'reversalTransactionId'=reversal.id::text))
 THEN RAISE EXCEPTION 'expense correction requires one atomic exact reversal, approved replacement and reasoned audit'; END IF;
END $$;
CREATE FUNCTION app_expense_correction_atomic_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM app_assert_expense_correction(NEW.id,NEW.organization_id);
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER expense_correction_atomic AFTER INSERT OR UPDATE ON expense
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_expense_correction_atomic_guard();

CREATE OR REPLACE FUNCTION app_expense_accounting_date_is_valid(expense_uuid uuid,organization_uuid uuid,journal_uuid uuid,source_timezone text)
RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT CASE WHEN e.corrects_expense_id IS NOT NULL THEN true WHEN EXISTS(SELECT 1 FROM accounting_period_adjustment p WHERE p.organization_id=organization_uuid AND p.expense_id=e.id)
 THEN EXISTS(SELECT 1 FROM accounting_period_adjustment p
   JOIN accounting_period c ON c.organization_id=p.organization_id AND c.id=p.period_id
   JOIN accounting_period_event v ON v.organization_id=p.organization_id AND v.id=p.period_event_id AND v.period_id=c.id
   WHERE p.organization_id=organization_uuid AND p.expense_id=e.id AND p.transaction_id=t.id
    AND p.created_by=t.created_by
    AND p.source_occurred_at=(e.occurred_on::timestamp AT TIME ZONE source_timezone)
    AND c.starts_at<=p.source_occurred_at AND p.source_occurred_at<c.ends_at
    AND (v.kind='CLOSE' OR (v.kind='REOPEN' AND v.reopens_until<=p.created_at)))
 ELSE (t.occurred_at AT TIME ZONE source_timezone)::date=e.occurred_on END
 FROM expense e JOIN financial_transaction t ON t.organization_id=e.organization_id AND t.id=journal_uuid
 WHERE e.organization_id=organization_uuid AND e.id=expense_uuid;
$$;
COMMIT;
