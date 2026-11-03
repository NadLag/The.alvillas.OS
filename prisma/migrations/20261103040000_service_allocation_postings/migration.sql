BEGIN;
-- CreateTable
CREATE TABLE "service_allocation_posting" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "admission_id" UUID NOT NULL,
    "transaction_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "previous_posting_id" UUID,
    "kind" VARCHAR(16) NOT NULL,
    "reverses_posting_id" UUID,
    "idempotency_key" UUID NOT NULL,
    "request_hash" CHAR(64) NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "service_allocation_posting_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "service_posting_history_idx" ON "service_allocation_posting"("organization_id", "source_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "service_posting_org_id_key" ON "service_allocation_posting"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "service_posting_source_version_key" ON "service_allocation_posting"("organization_id", "source_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "service_posting_previous_key" ON "service_allocation_posting"("organization_id", "previous_posting_id");

-- CreateIndex
CREATE UNIQUE INDEX "service_posting_original_key" ON "service_allocation_posting"("organization_id", "reverses_posting_id");

-- CreateIndex
CREATE UNIQUE INDEX "service_posting_journal_key" ON "service_allocation_posting"("organization_id", "transaction_id");

-- CreateIndex
CREATE UNIQUE INDEX "service_posting_nonce_key" ON "service_allocation_posting"("organization_id", "idempotency_key");

-- AddForeignKey
ALTER TABLE "service_allocation_posting" ADD CONSTRAINT "service_posting_org_fk" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "service_allocation_posting" ADD CONSTRAINT "service_posting_source_fk" FOREIGN KEY ("organization_id", "source_id") REFERENCES "service_financial_source"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "service_allocation_posting" ADD CONSTRAINT "service_posting_admission_fk" FOREIGN KEY ("organization_id", "admission_id") REFERENCES "service_allocation_admission"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "service_allocation_posting" ADD CONSTRAINT "service_posting_journal_fk" FOREIGN KEY ("organization_id", "transaction_id") REFERENCES "financial_transaction"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "service_allocation_posting" ADD CONSTRAINT "service_posting_actor_fk" FOREIGN KEY ("organization_id", "created_by") REFERENCES "user_account"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "service_allocation_posting" ADD CONSTRAINT "service_posting_previous_fk" FOREIGN KEY ("organization_id", "previous_posting_id") REFERENCES "service_allocation_posting"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "service_allocation_posting" ADD CONSTRAINT "service_posting_original_fk" FOREIGN KEY ("organization_id", "reverses_posting_id") REFERENCES "service_allocation_posting"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;


ALTER TABLE service_allocation_posting ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_allocation_posting FORCE ROW LEVEL SECURITY;
CREATE POLICY service_posting_tenant_isolation ON service_allocation_posting
 USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
 WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
CREATE TRIGGER service_posting_immutable BEFORE UPDATE OR DELETE ON service_allocation_posting FOR EACH ROW EXECUTE FUNCTION app_prevent_ledger_mutation();
ALTER TABLE service_allocation_posting ADD CONSTRAINT service_posting_values_check CHECK(version>=1 AND kind IN('RECOGNITION','REVERSAL') AND (kind='REVERSAL')=(reverses_posting_id IS NOT NULL) AND request_hash~'^[a-f0-9]{64}$' AND length(btrim(reason)) BETWEEN 6 AND 500);

CREATE FUNCTION app_service_posting_nonce_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text||':service-allocation-command:'||NEW.idempotency_key::text,0));
 IF EXISTS(SELECT 1 FROM service_allocation_posting WHERE organization_id=NEW.organization_id AND idempotency_key=NEW.idempotency_key)
 THEN RAISE EXCEPTION 'service command identity belongs to its original committed journal acknowledgement'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER zz_service_posting_nonce_fence BEFORE INSERT ON service_allocation_admission FOR EACH ROW EXECUTE FUNCTION app_service_posting_nonce_guard();
CREATE TRIGGER zz_service_posting_nonce_fence BEFORE INSERT ON service_allocation_provider_binding FOR EACH ROW EXECUTE FUNCTION app_service_posting_nonce_guard();

CREATE FUNCTION app_service_posting_birth_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE subject service_financial_source; admission service_allocation_admission; previous service_allocation_posting; original service_allocation_posting; journal financial_transaction;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text||':service-allocation-command:'||NEW.idempotency_key::text,0));
 SELECT * INTO subject FROM service_financial_source WHERE organization_id=NEW.organization_id AND id=NEW.source_id;
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text||':service-allocation-source:'||subject.cash_collection_id::text,0));
 SELECT * INTO admission FROM service_allocation_admission WHERE organization_id=NEW.organization_id AND id=NEW.admission_id;
 SELECT * INTO previous FROM service_allocation_posting WHERE organization_id=NEW.organization_id AND source_id=NEW.source_id ORDER BY version DESC LIMIT 1;
 SELECT * INTO journal FROM financial_transaction WHERE organization_id=NEW.organization_id AND id=NEW.transaction_id;
 IF subject.id IS NULL OR admission.id IS NULL OR admission.source_id<>subject.id OR journal.id IS NULL OR journal.created_by IS DISTINCT FROM NEW.created_by
  OR NEW.version<>COALESCE(previous.version,0)+1 OR NEW.previous_posting_id IS DISTINCT FROM previous.id
  OR NEW.created_at<admission.created_at OR NEW.created_at<previous.created_at OR NEW.created_at>clock_timestamp()
  OR journal.idempotency_key IS DISTINCT FROM 'service-allocation:'||NEW.idempotency_key::text
  OR journal.reference IS DISTINCT FROM 'SERVICE-ALLOCATION:'||subject.id::text||':'||NEW.version::text
  OR EXISTS(SELECT 1 FROM service_allocation_admission WHERE organization_id=NEW.organization_id AND idempotency_key=NEW.idempotency_key)
  OR EXISTS(SELECT 1 FROM service_allocation_provider_binding WHERE organization_id=NEW.organization_id AND idempotency_key=NEW.idempotency_key)
 THEN RAISE EXCEPTION 'service journal acknowledgement requires its actual tenant source, original command and consecutive immutable history'; END IF;
 IF NEW.kind='RECOGNITION' THEN
  IF journal.reverses_transaction_id IS NOT NULL OR NEW.admission_id IS DISTINCT FROM(SELECT id FROM service_allocation_admission WHERE organization_id=NEW.organization_id AND source_id=NEW.source_id ORDER BY version DESC LIMIT 1)
   OR EXISTS(SELECT 1 FROM service_allocation_posting p WHERE p.organization_id=NEW.organization_id AND p.source_id=NEW.source_id AND p.kind='RECOGNITION'
    AND NOT EXISTS(SELECT 1 FROM service_allocation_posting opposite WHERE opposite.organization_id=p.organization_id AND opposite.reverses_posting_id=p.id))
  THEN RAISE EXCEPTION 'an original service collection can have only one active reviewed allocation'; END IF;
 ELSE
  SELECT * INTO original FROM service_allocation_posting WHERE organization_id=NEW.organization_id AND id=NEW.reverses_posting_id;
  IF original.id IS NULL OR original.source_id<>NEW.source_id OR original.admission_id<>NEW.admission_id OR original.kind<>'RECOGNITION'
   OR journal.reverses_transaction_id IS DISTINCT FROM original.transaction_id
   OR EXISTS(SELECT 1 FROM service_allocation_posting WHERE organization_id=NEW.organization_id AND reverses_posting_id=original.id)
  THEN RAISE EXCEPTION 'a service correction must acknowledge the original allocation and its exact opposite journal'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER service_posting_birth_guard BEFORE INSERT ON service_allocation_posting FOR EACH ROW EXECUTE FUNCTION app_service_posting_birth_guard();

CREATE FUNCTION app_service_journal_row(account_code text,posting_side text,posting_amount numeric,currency_code text,posting_bucket text,posting_dimensions jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
 SELECT jsonb_build_object('code',account_code,'side',posting_side,'amount',to_char(posting_amount,'FM9999999999999990.00'),'currency',currency_code,'bucket',posting_bucket,'dimensions',posting_dimensions)
$$;

CREATE FUNCTION app_service_posting_exact_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE subject service_financial_source; receipt cash_collection; admission service_allocation_admission; journal financial_transaction; original service_allocation_posting;
 expected jsonb:='[]'; actual jsonb; dimensions jsonb; detail jsonb; component jsonb; owner_row jsonb; owner_count integer; owner_position integer; component_amount numeric; owner_amount numeric; remaining numeric; company_amount numeric:=0; expected_unallocated uuid;
BEGIN
 SELECT * INTO subject FROM service_financial_source WHERE organization_id=NEW.organization_id AND id=NEW.source_id;
 SELECT * INTO receipt FROM cash_collection WHERE organization_id=NEW.organization_id AND id=subject.cash_collection_id;
 SELECT * INTO admission FROM service_allocation_admission WHERE organization_id=NEW.organization_id AND id=NEW.admission_id;
 SELECT * INTO journal FROM financial_transaction WHERE organization_id=NEW.organization_id AND id=NEW.transaction_id;
 IF NOT journal.sealed THEN RAISE EXCEPTION 'a service allocation must acknowledge an actual sealed native journal'; END IF;
 SELECT jsonb_agg(app_service_journal_row(a.code,p.side,p.amount,p.currency,p.bucket,p.dimensions) ORDER BY app_service_journal_row(a.code,p.side,p.amount,p.currency,p.bucket,p.dimensions)::text) INTO actual
  FROM posting p JOIN ledger_account a ON a.organization_id=p.organization_id AND a.id=p.ledger_account_id WHERE p.organization_id=NEW.organization_id AND p.transaction_id=NEW.transaction_id;
 IF NEW.kind='RECOGNITION' THEN
  IF journal.occurred_at IS DISTINCT FROM(admission.snapshot->'source'->>'completedAt')::timestamptz
   OR NOT EXISTS(SELECT 1 FROM financial_transaction t WHERE t.organization_id=NEW.organization_id AND t.id=receipt.transaction_id AND t.sealed AND NOT EXISTS(SELECT 1 FROM financial_transaction reversal WHERE reversal.organization_id=t.organization_id AND reversal.reverses_transaction_id=t.id))
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(admission.snapshot->'providerCosts') cost WHERE
    NOT EXISTS(SELECT 1 FROM service_allocation_provider_binding binding WHERE binding.organization_id=NEW.organization_id AND binding.id::text=cost->>'bindingId' AND binding.source_id=subject.id AND binding.state='ATTACHED'
     AND binding.id=(SELECT id FROM service_allocation_provider_binding latest WHERE latest.organization_id=binding.organization_id AND latest.supplier_invoice_line_id IS NOT DISTINCT FROM binding.supplier_invoice_line_id AND latest.employee_cost_id IS NOT DISTINCT FROM binding.employee_cost_id ORDER BY version DESC LIMIT 1))
    OR NOT EXISTS(SELECT 1 FROM financial_transaction t WHERE t.organization_id=NEW.organization_id AND t.id::text=cost->>'transactionId' AND t.sealed AND NOT EXISTS(SELECT 1 FROM financial_transaction reversal WHERE reversal.organization_id=t.organization_id AND reversal.reverses_transaction_id=t.id)))
  THEN RAISE EXCEPTION 'service recognition requires its original completion instant, unreversed cash and current native provider evidence'; END IF;
  SELECT p.ledger_account_id INTO expected_unallocated FROM posting p JOIN ledger_account a ON a.organization_id=p.organization_id AND a.id=p.ledger_account_id WHERE p.organization_id=NEW.organization_id AND p.transaction_id=receipt.transaction_id AND p.side='CREDIT' AND a.code='UNALLOCATED_COLLECTIONS';
  IF expected_unallocated IS NULL OR NOT EXISTS(SELECT 1 FROM posting WHERE organization_id=NEW.organization_id AND transaction_id=journal.id AND side='DEBIT' AND ledger_account_id=expected_unallocated)
  THEN RAISE EXCEPTION 'service allocation must release the actual original unallocated collection account'; END IF;
  dimensions=jsonb_build_object('organization_id',NEW.organization_id::text,'property_id',receipt.property_id::text,'cash_collection_id',receipt.id::text,'task_id',receipt.task_id::text,'completion_event_id',subject.completion_event_id::text,'service_key',admission.service_key,'service_allocation_policy_id',admission.allocation_rule_id::text,'service_source_id',subject.id::text,'service_admission_id',admission.id::text,'source','SERVICE_ALLOCATION');
  IF receipt.reservation_id IS NOT NULL THEN dimensions=dimensions||jsonb_build_object('reservation_id',receipt.reservation_id::text); END IF;
  expected=expected||jsonb_build_array(app_service_journal_row('UNALLOCATED_COLLECTIONS','DEBIT',receipt.amount,receipt.currency,'SERVICE_ALLOCATION',dimensions));
  FOR component IN SELECT value FROM jsonb_array_elements(admission.snapshot->'parts') LOOP
   component_amount=(component->'amount'->>'amount')::numeric;IF component_amount=0 THEN CONTINUE; END IF;
   detail=dimensions||jsonb_build_object('service_component',component->>'key');
   IF component->>'beneficiary'='OWNER' THEN
    remaining=component_amount;owner_position=0;owner_count=jsonb_array_length(admission.snapshot->'owners');
    FOR owner_row IN SELECT value FROM jsonb_array_elements(admission.snapshot->'owners') ORDER BY value->>'ownerId' LOOP
     owner_position=owner_position+1;owner_amount=CASE WHEN owner_position=owner_count THEN remaining ELSE least(remaining,round(component_amount*(owner_row->>'shareBps')::numeric/10000,2)) END;remaining=remaining-owner_amount;
     IF owner_amount>0 THEN expected=expected||jsonb_build_array(app_service_journal_row('OWNER_PAYABLE','CREDIT',owner_amount,receipt.currency,'OWNER_SERVICES',detail||jsonb_build_object('owner_id',owner_row->>'ownerId'))); END IF;
    END LOOP;
    IF owner_count=0 OR remaining<>0 THEN RAISE EXCEPTION 'actual original owner shares must conserve every service cent'; END IF;
   ELSIF component->>'beneficiary'='TAX' THEN
    expected=expected||jsonb_build_array(app_service_journal_row('SERVICE_TAX_PAYABLE','CREDIT',component_amount,receipt.currency,'SERVICE_TAX',detail||jsonb_build_object('tax_rule_key',component->>'taxRuleKey')));
   ELSE company_amount=company_amount+component_amount;
   END IF;
  END LOOP;
  IF company_amount>0 THEN expected=expected||jsonb_build_array(app_service_journal_row('ALVILLAS_SERVICE_REVENUE','CREDIT',company_amount,receipt.currency,'ALVILLAS_SERVICE_REVENUE',dimensions)); END IF;
 ELSE
  SELECT * INTO original FROM service_allocation_posting WHERE organization_id=NEW.organization_id AND id=NEW.reverses_posting_id;
  SELECT jsonb_agg(app_service_journal_row(a.code,CASE WHEN p.side='DEBIT' THEN 'CREDIT' ELSE 'DEBIT' END,p.amount,p.currency,p.bucket,p.dimensions)) INTO expected
   FROM posting p JOIN ledger_account a ON a.organization_id=p.organization_id AND a.id=p.ledger_account_id WHERE p.organization_id=NEW.organization_id AND p.transaction_id=original.transaction_id;
 END IF;
 SELECT jsonb_agg(value ORDER BY value::text) INTO expected FROM jsonb_array_elements(expected);
 IF expected IS DISTINCT FROM actual OR EXISTS(SELECT 1 FROM posting p JOIN ledger_account a ON a.organization_id=p.organization_id AND a.id=p.ledger_account_id WHERE p.organization_id=NEW.organization_id AND p.transaction_id=journal.id AND(a.archived_at IS NOT NULL OR
   CASE WHEN a.code='ALVILLAS_SERVICE_REVENUE' THEN a.account_type<>'ALVILLAS_OWN' ELSE a.account_type<>'CLAIM_OWNERSHIP' END OR a.normal_side<>'CREDIT'))
 THEN RAISE EXCEPTION 'service allocation must preserve exact original Money, ownership, tax and private aggregated company revenue'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER service_posting_exact_guard AFTER INSERT ON service_allocation_posting DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_service_posting_exact_guard();

CREATE FUNCTION app_service_posting_audit_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM audit_log a JOIN service_financial_source s ON s.organization_id=a.organization_id AND s.id=a.resource_id JOIN cash_collection c ON c.organization_id=s.organization_id AND c.id=s.cash_collection_id
  WHERE a.organization_id=NEW.organization_id AND a.actor_id=NEW.created_by AND a.resource_type='service_allocation' AND a.resource_id=NEW.source_id AND a.property_scope_id=c.property_id
   AND a.action=(CASE WHEN NEW.kind='RECOGNITION' THEN 'service_allocation.recognized' ELSE 'service_allocation.reversed' END)
   AND a.after->>'sourceId'=NEW.source_id::text AND a.after->>'admissionId'=NEW.admission_id::text AND a.after->>'postingId'=NEW.id::text AND a.after->>'transactionId'=NEW.transaction_id::text
   AND a.after->>'version'=NEW.version::text AND a.after->>'idempotencyKey'=NEW.idempotency_key::text AND a.after->>'requestHash'=NEW.request_hash AND a.reason=NEW.reason AND a.occurred_at=NEW.created_at
   AND(NEW.kind='RECOGNITION' OR a.after->>'originalPostingId'=NEW.reverses_posting_id::text AND a.after->>'originalTransactionId'=(SELECT transaction_id::text FROM service_allocation_posting WHERE organization_id=NEW.organization_id AND id=NEW.reverses_posting_id)))
 THEN RAISE EXCEPTION 'the original service journal acknowledgement and its actual-source audit must commit atomically'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER service_posting_atomic_audit AFTER INSERT ON service_allocation_posting DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_service_posting_audit_guard();

CREATE FUNCTION app_service_posting_journal_ack_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM service_allocation_posting a WHERE a.organization_id=NEW.organization_id AND a.transaction_id=NEW.transaction_id
  AND a.source_id::text=NEW.dimensions->>'service_source_id' AND a.admission_id::text=NEW.dimensions->>'service_admission_id')
 THEN RAISE EXCEPTION 'a service movement requires its native reviewed source acknowledgement in the same transaction'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER service_posting_native_ack AFTER INSERT ON posting DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
 WHEN(NEW.dimensions->>'source'='SERVICE_ALLOCATION' OR NEW.bucket IN('SERVICE_ALLOCATION','OWNER_SERVICES','ALVILLAS_SERVICE_REVENUE','SERVICE_TAX')) EXECUTE FUNCTION app_service_posting_journal_ack_guard();

CREATE FUNCTION app_service_provider_posting_fence() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF NEW.state='RELEASED' AND EXISTS(SELECT 1 FROM service_allocation_provider_part part JOIN service_allocation_posting allocation ON allocation.organization_id=part.organization_id AND allocation.admission_id=part.admission_id
  WHERE part.organization_id=NEW.organization_id AND part.binding_id=NEW.previous_binding_id AND allocation.kind='RECOGNITION'
   AND NOT EXISTS(SELECT 1 FROM service_allocation_posting opposite WHERE opposite.organization_id=allocation.organization_id AND opposite.reverses_posting_id=allocation.id))
 THEN RAISE EXCEPTION 'reverse the original service allocation before releasing its provider source'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER service_provider_guard_posting_fence BEFORE INSERT ON service_allocation_provider_binding FOR EACH ROW EXECUTE FUNCTION app_service_provider_posting_fence();

CREATE FUNCTION app_service_native_source_reversal_fence() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE subject record;
BEGIN
 FOR subject IN
  SELECT DISTINCT source.id,source.cash_collection_id FROM service_financial_source source JOIN cash_collection collection ON collection.organization_id=source.organization_id AND collection.id=source.cash_collection_id
  WHERE source.organization_id=NEW.organization_id AND(collection.transaction_id=NEW.reverses_transaction_id OR EXISTS(
   SELECT 1 FROM service_allocation_provider_binding binding WHERE binding.organization_id=source.organization_id AND binding.source_id=source.id AND(
    EXISTS(SELECT 1 FROM supplier_invoice_recognition_line native WHERE native.organization_id=binding.organization_id AND native.invoice_line_id=binding.supplier_invoice_line_id AND native.transaction_id=NEW.reverses_transaction_id)
    OR EXISTS(SELECT 1 FROM employee_compensation_recognition_line native WHERE native.organization_id=binding.organization_id AND native.cost_id=binding.employee_cost_id AND native.transaction_id=NEW.reverses_transaction_id)))) ORDER BY source.cash_collection_id
 LOOP
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text||':service-allocation-source:'||subject.cash_collection_id::text,0));
  IF EXISTS(SELECT 1 FROM service_allocation_posting allocation WHERE allocation.organization_id=NEW.organization_id AND allocation.source_id=subject.id AND allocation.kind='RECOGNITION'
   AND NOT EXISTS(SELECT 1 FROM service_allocation_posting opposite WHERE opposite.organization_id=allocation.organization_id AND opposite.reverses_posting_id=allocation.id)
   AND(EXISTS(SELECT 1 FROM cash_collection WHERE organization_id=NEW.organization_id AND id=subject.cash_collection_id AND transaction_id=NEW.reverses_transaction_id)
    OR EXISTS(SELECT 1 FROM service_allocation_provider_part part JOIN service_allocation_provider_binding binding ON binding.organization_id=part.organization_id AND binding.id=part.binding_id
     WHERE part.organization_id=allocation.organization_id AND part.admission_id=allocation.admission_id AND(
      EXISTS(SELECT 1 FROM supplier_invoice_recognition_line native WHERE native.organization_id=binding.organization_id AND native.invoice_line_id=binding.supplier_invoice_line_id AND native.transaction_id=NEW.reverses_transaction_id)
      OR EXISTS(SELECT 1 FROM employee_compensation_recognition_line native WHERE native.organization_id=binding.organization_id AND native.cost_id=binding.employee_cost_id AND native.transaction_id=NEW.reverses_transaction_id)))))
  THEN RAISE EXCEPTION 'reverse the actual active service allocation before reversing its original cash or provider cost'; END IF;
 END LOOP;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER service_native_source_reversal_fence AFTER INSERT ON financial_transaction DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.reverses_transaction_id IS NOT NULL) EXECUTE FUNCTION app_service_native_source_reversal_fence();

COMMIT;
