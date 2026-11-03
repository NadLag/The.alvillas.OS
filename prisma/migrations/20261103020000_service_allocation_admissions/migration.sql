BEGIN;
-- CreateTable
CREATE TABLE "service_financial_source" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "source_kind" TEXT NOT NULL,
    "cash_collection_id" UUID NOT NULL,
    "completion_event_id" UUID NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "service_financial_source_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_allocation_admission" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "previous_admission_id" UUID,
    "idempotency_key" UUID NOT NULL,
    "request_hash" CHAR(64) NOT NULL,
    "review_fingerprint" CHAR(64) NOT NULL,
    "allocation_rule_id" UUID NOT NULL,
    "tax_rule_id" UUID NOT NULL,
    "service_key" VARCHAR(100) NOT NULL,
    "snapshot" JSONB NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "service_allocation_admission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_allocation_provider_binding" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "idempotency_key" UUID NOT NULL,
    "request_hash" CHAR(64) NOT NULL,
    "supplier_invoice_line_id" UUID,
    "employee_cost_id" UUID,
    "version" INTEGER NOT NULL,
    "previous_binding_id" UUID,
    "state" TEXT NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "service_allocation_provider_binding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_allocation_provider_part" (
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "organization_id" UUID NOT NULL,
    "admission_id" UUID NOT NULL,
    "binding_id" UUID NOT NULL,
    "component_key" VARCHAR(100) NOT NULL,

    CONSTRAINT "service_allocation_provider_part_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "service_source_history_idx" ON "service_financial_source"("organization_id", "created_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "service_source_org_id_key" ON "service_financial_source"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "service_source_collection_key" ON "service_financial_source"("organization_id", "cash_collection_id");

-- CreateIndex
CREATE INDEX "service_admission_history_idx" ON "service_allocation_admission"("organization_id", "source_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "service_admission_org_id_key" ON "service_allocation_admission"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "service_admission_nonce_key" ON "service_allocation_admission"("organization_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "service_admission_version_key" ON "service_allocation_admission"("organization_id", "source_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "service_admission_successor_key" ON "service_allocation_admission"("organization_id", "previous_admission_id");

-- CreateIndex
CREATE INDEX "service_provider_history_idx" ON "service_allocation_provider_binding"("organization_id", "source_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "service_provider_org_id_key" ON "service_allocation_provider_binding"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "service_provider_nonce_key" ON "service_allocation_provider_binding"("organization_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "service_provider_invoice_version_key" ON "service_allocation_provider_binding"("organization_id", "supplier_invoice_line_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "service_provider_employee_version_key" ON "service_allocation_provider_binding"("organization_id", "employee_cost_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "service_provider_successor_key" ON "service_allocation_provider_binding"("organization_id", "previous_binding_id");

-- CreateIndex
CREATE UNIQUE INDEX "service_part_org_id_key" ON "service_allocation_provider_part"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "service_part_component_key" ON "service_allocation_provider_part"("organization_id", "admission_id", "component_key");

-- CreateIndex
CREATE UNIQUE INDEX "service_part_binding_key" ON "service_allocation_provider_part"("organization_id", "admission_id", "binding_id");

-- AddForeignKey
ALTER TABLE "service_financial_source" ADD CONSTRAINT "service_source_org_fk" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "service_financial_source" ADD CONSTRAINT "service_source_collection_fk" FOREIGN KEY ("organization_id", "cash_collection_id") REFERENCES "cash_collection"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "service_financial_source" ADD CONSTRAINT "service_source_completion_fk" FOREIGN KEY ("organization_id", "completion_event_id") REFERENCES "operation_task_event"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "service_financial_source" ADD CONSTRAINT "service_source_actor_fk" FOREIGN KEY ("organization_id", "created_by") REFERENCES "user_account"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "service_allocation_admission" ADD CONSTRAINT "service_admission_org_fk" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "service_allocation_admission" ADD CONSTRAINT "service_admission_source_fk" FOREIGN KEY ("organization_id", "source_id") REFERENCES "service_financial_source"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "service_allocation_admission" ADD CONSTRAINT "service_admission_previous_fk" FOREIGN KEY ("organization_id", "previous_admission_id") REFERENCES "service_allocation_admission"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "service_allocation_admission" ADD CONSTRAINT "service_admission_policy_fk" FOREIGN KEY ("organization_id", "allocation_rule_id") REFERENCES "config_rule"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "service_allocation_admission" ADD CONSTRAINT "service_admission_tax_fk" FOREIGN KEY ("organization_id", "tax_rule_id") REFERENCES "config_rule"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "service_allocation_admission" ADD CONSTRAINT "service_admission_actor_fk" FOREIGN KEY ("organization_id", "created_by") REFERENCES "user_account"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "service_allocation_provider_binding" ADD CONSTRAINT "service_provider_org_fk" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "service_allocation_provider_binding" ADD CONSTRAINT "service_provider_source_fk" FOREIGN KEY ("organization_id", "source_id") REFERENCES "service_financial_source"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "service_allocation_provider_binding" ADD CONSTRAINT "service_provider_invoice_fk" FOREIGN KEY ("organization_id", "supplier_invoice_line_id") REFERENCES "supplier_invoice_line"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "service_allocation_provider_binding" ADD CONSTRAINT "service_provider_employee_fk" FOREIGN KEY ("organization_id", "employee_cost_id") REFERENCES "employee_compensation_cost"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "service_allocation_provider_binding" ADD CONSTRAINT "service_provider_previous_fk" FOREIGN KEY ("organization_id", "previous_binding_id") REFERENCES "service_allocation_provider_binding"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "service_allocation_provider_binding" ADD CONSTRAINT "service_provider_actor_fk" FOREIGN KEY ("organization_id", "created_by") REFERENCES "user_account"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "service_allocation_provider_part" ADD CONSTRAINT "service_part_org_fk" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "service_allocation_provider_part" ADD CONSTRAINT "service_part_admission_fk" FOREIGN KEY ("organization_id", "admission_id") REFERENCES "service_allocation_admission"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "service_allocation_provider_part" ADD CONSTRAINT "service_part_binding_fk" FOREIGN KEY ("organization_id", "binding_id") REFERENCES "service_allocation_provider_binding"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;


DO $$ DECLARE table_name text; BEGIN
 FOREACH table_name IN ARRAY ARRAY['service_financial_source','service_allocation_admission','service_allocation_provider_binding','service_allocation_provider_part'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',table_name);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',table_name);
  EXECUTE format('CREATE POLICY %I ON %I USING(organization_id=NULLIF(current_setting(''app.current_organization_id'',true),'''')::uuid) WITH CHECK(organization_id=NULLIF(current_setting(''app.current_organization_id'',true),'''')::uuid)',table_name||'_tenant_isolation',table_name);
  EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION app_prevent_ledger_mutation()',table_name||'_immutable',table_name);
 END LOOP;
END $$;

ALTER TABLE service_financial_source ADD CONSTRAINT service_source_kind_check CHECK(source_kind='COMPLETED_SERVICE_COLLECTION');
ALTER TABLE service_allocation_admission ADD CONSTRAINT service_admission_values_check CHECK(version>=1 AND request_hash~'^[a-f0-9]{64}$' AND review_fingerprint~'^[a-f0-9]{64}$' AND service_key~'^[a-z][a-z0-9_.-]{0,99}$' AND length(btrim(reason)) BETWEEN 6 AND 500);
ALTER TABLE service_allocation_provider_binding ADD CONSTRAINT service_provider_values_check CHECK(version>=1 AND request_hash~'^[a-f0-9]{64}$' AND state IN('ATTACHED','RELEASED') AND num_nonnulls(supplier_invoice_line_id,employee_cost_id)=1 AND length(btrim(reason)) BETWEEN 6 AND 500);
ALTER TABLE service_allocation_provider_part ADD CONSTRAINT service_part_key_check CHECK(component_key~'^[a-z][a-z0-9_.-]{0,99}$');

CREATE FUNCTION app_service_source_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE receipt cash_collection; job operation_task; completion operation_task_event;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text||':service-allocation-source:'||NEW.cash_collection_id::text,0));
 SELECT * INTO receipt FROM cash_collection WHERE organization_id=NEW.organization_id AND id=NEW.cash_collection_id;
 SELECT * INTO completion FROM operation_task_event WHERE organization_id=NEW.organization_id AND id=NEW.completion_event_id;
 SELECT * INTO job FROM operation_task WHERE organization_id=NEW.organization_id AND id=receipt.task_id;
 IF receipt.id IS NULL OR completion.id IS NULL OR job.id IS NULL OR job.state<>'COMPLETED' OR job.archived_at IS NOT NULL
  OR job.completed_at IS NULL OR job.completed_by_person_id IS NULL OR job.completion_idempotency_key IS NULL
  OR completion.task_id<>receipt.task_id OR completion.kind<>'CHANGED' OR completion.after->>'state' IS DISTINCT FROM 'COMPLETED'
  OR completion.before->>'state' IS NULL OR completion.before->>'state'='COMPLETED' OR completion.actor_id IS NULL OR completion.version>job.version
  OR completion.after->>'id' IS DISTINCT FROM job.id::text OR completion.after->>'organization_id' IS DISTINCT FROM NEW.organization_id::text
  OR completion.after->>'property_id' IS DISTINCT FROM receipt.property_id::text OR job.property_id<>receipt.property_id
  OR completion.after->>'completed_by_person_id' IS DISTINCT FROM job.completed_by_person_id::text
  OR completion.after->>'completed_by_user_account_id' IS DISTINCT FROM job.completed_by_user_account_id::text
  OR completion.after->>'completion_idempotency_key' IS DISTINCT FROM job.completion_idempotency_key::text
  OR completion.after->>'completion_source' IS DISTINCT FROM job.completion_source
  OR completion.after->>'required_role_key' IS DISTINCT FROM job.required_role_key
  OR completion.after->>'validated_by_person_id' IS DISTINCT FROM job.validated_by_person_id::text
  OR completion.after->>'validated_by_user_account_id' IS DISTINCT FROM job.validated_by_user_account_id::text
  OR (completion.after->>'validated_at')::timestamptz IS DISTINCT FROM job.validated_at
  OR completion.after->>'validation_reason' IS DISTINCT FROM job.validation_reason
  OR (completion.after->>'completed_at')::timestamptz IS DISTINCT FROM job.completed_at
  OR NEW.created_at<receipt.recorded_at OR NEW.created_at<job.completed_at OR NEW.created_at>clock_timestamp()
  OR NOT EXISTS(SELECT 1 FROM property WHERE organization_id=NEW.organization_id AND id=receipt.property_id AND archived_at IS NULL)
  OR NOT EXISTS(SELECT 1 FROM financial_transaction t WHERE t.organization_id=NEW.organization_id AND t.id=receipt.transaction_id AND t.sealed AND t.reverses_transaction_id IS NULL
    AND NOT EXISTS(SELECT 1 FROM financial_transaction opposite WHERE opposite.organization_id=t.organization_id AND opposite.reverses_transaction_id=t.id))
  OR NOT EXISTS(SELECT 1 FROM operation_task_checklist_item WHERE organization_id=NEW.organization_id AND task_id=job.id)
  OR EXISTS(SELECT 1 FROM operation_task_checklist_item WHERE organization_id=NEW.organization_id AND task_id=job.id AND
    (completed_at IS NULL OR completed_at>job.completed_at OR completed_by_person_id IS DISTINCT FROM job.completed_by_person_id OR completed_by_user_account_id IS DISTINCT FROM job.completed_by_user_account_id))
 THEN RAISE EXCEPTION 'service source requires its actual tenant collection and immutable completed work'; END IF;
 IF job.completion_source='PROXY' THEN
  IF job.validated_by_user_account_id IS DISTINCT FROM completion.actor_id OR job.validated_by_person_id IS NULL OR job.validated_by_person_id=job.completed_by_person_id
   OR job.validated_at IS NULL OR length(btrim(COALESCE(job.validation_reason,'')))<6
  THEN RAISE EXCEPTION 'service source requires its actual distinct completion validator'; END IF;
 ELSIF COALESCE(job.completion_source,'') NOT IN('SELF','OFFLINE_SYNC') OR job.completed_by_user_account_id IS DISTINCT FROM completion.actor_id THEN
  RAISE EXCEPTION 'service source requires its actual recorded performer';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER service_source_guard BEFORE INSERT ON service_financial_source FOR EACH ROW EXECUTE FUNCTION app_service_source_guard();

-- Independent exact SQL assertion of the configured Money apportionment; no financial rows are repriced.
CREATE FUNCTION app_service_allocation_parts(recipe jsonb,gross numeric,currency_code text) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE component jsonb; fixed_total numeric:=0; bps_total integer:=0; remainder_count integer:=0; variable_count integer:=0; available_units numeric; result jsonb;
BEGIN
 IF gross<=0 OR gross>9999999999999999.99 OR gross<>round(gross,2) OR currency_code!~'^[A-Z]{3}$'
  OR recipe->>'currency' IS DISTINCT FROM currency_code OR recipe->>'basis' IS DISTINCT FROM 'COLLECTED_GROSS_LESS_FIXED_COMPONENTS'
  OR recipe->>'rounding' IS DISTINCT FROM 'LARGEST_REMAINDER' OR recipe->>'provider_treatment' IS DISTINCT FROM 'REVENUE_WITH_EXISTING_COMPANY_COST'
  OR jsonb_typeof(recipe->'components') IS DISTINCT FROM 'array' OR jsonb_array_length(recipe->'components') NOT BETWEEN 1 AND 100
  OR jsonb_typeof(recipe->'rounding_priority') IS DISTINCT FROM 'array' OR jsonb_typeof(recipe->'tax_rule_keys') IS DISTINCT FROM 'array'
  OR jsonb_array_length(recipe->'tax_rule_keys') NOT BETWEEN 1 AND 20
 THEN RAISE EXCEPTION 'explicit actual service allocation recipe required'; END IF;
 FOR component IN SELECT value FROM jsonb_array_elements(recipe->'components') LOOP
  IF COALESCE(component->>'key','')!~'^[a-z][a-z0-9_.-]{0,99}$' OR COALESCE(component->>'beneficiary','') NOT IN('OWNER','COMPANY','SUPPLIER','PERSON','TAX')
   OR COALESCE(component->>'mode','') NOT IN('FIXED','BASIS_POINTS','REMAINDER')
   OR (component->>'beneficiary'='TAX') IS DISTINCT FROM (component ? 'tax_rule_key')
   OR component ? 'tax_rule_key' AND NOT (recipe->'tax_rule_keys' ? (component->>'tax_rule_key'))
  THEN RAISE EXCEPTION 'invalid service component or tax policy identity'; END IF;
  IF component->>'mode'='FIXED' THEN
   IF jsonb_typeof(component->'amount') IS DISTINCT FROM 'string' OR component->>'amount'!~'^(0|[1-9][0-9]{0,15})(\.[0-9]{1,2})?$' THEN RAISE EXCEPTION 'exact fixed service Money required'; END IF;
   fixed_total=fixed_total+(component->>'amount')::numeric;
  ELSIF component->>'mode'='BASIS_POINTS' THEN
   IF COALESCE(component->>'basis_points','')!~'^[0-9]{1,5}$' OR (component->>'basis_points')::integer>10000 THEN RAISE EXCEPTION 'explicit service basis points required'; END IF;
   bps_total=bps_total+(component->>'basis_points')::integer;variable_count=variable_count+1;
  ELSE remainder_count=remainder_count+1;variable_count=variable_count+1;
  END IF;
 END LOOP;
 IF fixed_total>gross OR bps_total>10000 OR remainder_count<>1 OR
  (SELECT count(DISTINCT value->>'key') FROM jsonb_array_elements(recipe->'components'))<>jsonb_array_length(recipe->'components')
  OR jsonb_array_length(recipe->'rounding_priority')<>variable_count
  OR (SELECT count(DISTINCT value#>>'{}') FROM jsonb_array_elements(recipe->'rounding_priority'))<>variable_count
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(recipe->'components') c WHERE c->>'mode'<>'FIXED' AND NOT (recipe->'rounding_priority' ? (c->>'key')))
  OR (SELECT count(DISTINCT value#>>'{}') FROM jsonb_array_elements(recipe->'tax_rule_keys'))<>jsonb_array_length(recipe->'tax_rule_keys')
 THEN RAISE EXCEPTION 'service proceeds, obligations and configured rounding identities must conserve the original amount'; END IF;
 available_units=(gross-fixed_total)*100;
 WITH components AS MATERIALIZED(SELECT value c,ordinality position FROM jsonb_array_elements(recipe->'components') WITH ORDINALITY),
 weighted AS(SELECT c->>'key' key,available_units*(CASE WHEN c->>'mode'='REMAINDER' THEN 10000-bps_total ELSE (c->>'basis_points')::integer END) numerator,
  (SELECT ordinality FROM jsonb_array_elements(recipe->'rounding_priority') WITH ORDINALITY p WHERE p.value#>>'{}'=c->>'key') priority
  FROM components WHERE c->>'mode'<>'FIXED'),
 floors AS(SELECT *,floor(numerator/10000) units,mod(numerator,10000) fraction FROM weighted),
 ranked AS(SELECT *,row_number() OVER(ORDER BY fraction DESC,priority) rank,available_units-sum(units) OVER() residual FROM floors),
 amounts AS(SELECT key,(units+CASE WHEN rank<=residual THEN 1 ELSE 0 END)/100 amount FROM ranked)
 SELECT jsonb_agg(jsonb_build_object('key',c->>'key','beneficiary',c->>'beneficiary','amount',jsonb_build_object('amount',to_char(CASE WHEN c->>'mode'='FIXED' THEN (c->>'amount')::numeric ELSE amounts.amount END,'FM9999999999999990.00'),'currency',currency_code),'taxRuleKey',c->'tax_rule_key') ORDER BY position)
 INTO result FROM components LEFT JOIN amounts ON amounts.key=c->>'key';
 RETURN result;
END $$;

CREATE FUNCTION app_service_provider_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE previous service_allocation_provider_binding; subject service_financial_source; receipt cash_collection; source_amount numeric; source_currency text; source_property uuid; source_reservation uuid; source_journal uuid; source_kind text; source_cost uuid;
BEGIN
 source_kind=CASE WHEN NEW.supplier_invoice_line_id IS NOT NULL THEN 'SUPPLIER_INVOICE_LINE' ELSE 'EMPLOYEE_COST' END;source_cost=COALESCE(NEW.supplier_invoice_line_id,NEW.employee_cost_id);
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text||':service-allocation-command:'||NEW.idempotency_key::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text||':service-allocation-provider:'||source_kind||':'||source_cost::text,0));
 SELECT * INTO subject FROM service_financial_source WHERE organization_id=NEW.organization_id AND id=NEW.source_id;
 SELECT * INTO receipt FROM cash_collection WHERE organization_id=NEW.organization_id AND id=subject.cash_collection_id;
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text||':service-allocation-source:'||receipt.id::text,0));
 SELECT * INTO previous FROM service_allocation_provider_binding WHERE organization_id=NEW.organization_id AND
  supplier_invoice_line_id IS NOT DISTINCT FROM NEW.supplier_invoice_line_id AND employee_cost_id IS NOT DISTINCT FROM NEW.employee_cost_id ORDER BY version DESC LIMIT 1;
 IF subject.id IS NULL OR receipt.id IS NULL OR NEW.version<>COALESCE(previous.version,0)+1 OR NEW.previous_binding_id IS DISTINCT FROM previous.id
  OR NEW.created_at<subject.created_at OR NEW.created_at<previous.created_at OR NEW.created_at>clock_timestamp()
  OR EXISTS(SELECT 1 FROM service_allocation_admission WHERE organization_id=NEW.organization_id AND idempotency_key=NEW.idempotency_key)
  OR NEW.state='ATTACHED' AND previous.state='ATTACHED'
  OR NEW.state='RELEASED' AND (previous.id IS NULL OR previous.state<>'ATTACHED' OR previous.source_id<>NEW.source_id)
 THEN RAISE EXCEPTION 'provider binding requires its original consecutive source and command identity'; END IF;
 IF NEW.state='ATTACHED' THEN
  IF NEW.supplier_invoice_line_id IS NOT NULL THEN
   SELECT l.amount,l.currency,l.property_id,l.reservation_id,r.transaction_id INTO source_amount,source_currency,source_property,source_reservation,source_journal
    FROM supplier_invoice_line l JOIN supplier_invoice_recognition_line r ON r.organization_id=l.organization_id AND r.invoice_line_id=l.id
    WHERE l.organization_id=NEW.organization_id AND l.id=NEW.supplier_invoice_line_id;
  ELSE
   SELECT l.amount,l.currency,l.property_id,l.reservation_id,r.transaction_id INTO source_amount,source_currency,source_property,source_reservation,source_journal
    FROM employee_compensation_cost l JOIN employee_compensation_recognition_line r ON r.organization_id=l.organization_id AND r.cost_id=l.id
    WHERE l.organization_id=NEW.organization_id AND l.id=NEW.employee_cost_id;
  END IF;
  IF source_journal IS NULL OR source_currency<>receipt.currency OR source_property IS NOT NULL AND source_property<>receipt.property_id
   OR source_reservation IS NOT NULL AND source_reservation IS DISTINCT FROM receipt.reservation_id
   OR NOT EXISTS(SELECT 1 FROM financial_transaction t WHERE t.organization_id=NEW.organization_id AND t.id=source_journal AND t.sealed
    AND NOT EXISTS(SELECT 1 FROM financial_transaction reversal WHERE reversal.organization_id=t.organization_id AND reversal.reverses_transaction_id=t.id))
   OR (SELECT COALESCE(sum(p.amount),0) FROM posting p WHERE p.organization_id=NEW.organization_id AND p.transaction_id=source_journal AND p.side='DEBIT')<>source_amount
   OR (SELECT COALESCE(sum(p.amount),0) FROM posting p JOIN ledger_account a ON a.organization_id=p.organization_id AND a.id=p.ledger_account_id
    WHERE p.organization_id=NEW.organization_id AND p.transaction_id=source_journal AND p.side='DEBIT' AND a.account_type='ALVILLAS_OWN')<>source_amount
  THEN RAISE EXCEPTION 'provider binding requires its actual recognized company cost and original native journal'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER service_provider_guard BEFORE INSERT ON service_allocation_provider_binding FOR EACH ROW EXECUTE FUNCTION app_service_provider_guard();

CREATE FUNCTION app_service_admission_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE previous service_allocation_admission; subject service_financial_source; receipt cash_collection; job operation_task; policy config_rule; taxes config_rule; recipe jsonb; selected_policy uuid; selected_tax uuid; assessment jsonb; tax_entry jsonb; expected_tax numeric; actual_tax numeric; currency_minor_unit integer; expected_owners jsonb;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text||':service-allocation-command:'||NEW.idempotency_key::text,0));
 SELECT * INTO subject FROM service_financial_source WHERE organization_id=NEW.organization_id AND id=NEW.source_id;
 SELECT * INTO receipt FROM cash_collection WHERE organization_id=NEW.organization_id AND id=subject.cash_collection_id;
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text||':service-allocation-source:'||receipt.id::text,0));
 SELECT * INTO job FROM operation_task WHERE organization_id=NEW.organization_id AND id=receipt.task_id;
 SELECT * INTO previous FROM service_allocation_admission WHERE organization_id=NEW.organization_id AND source_id=NEW.source_id ORDER BY version DESC LIMIT 1;
 SELECT * INTO policy FROM config_rule WHERE organization_id=NEW.organization_id AND id=NEW.allocation_rule_id;
 SELECT * INTO taxes FROM config_rule WHERE organization_id=NEW.organization_id AND id=NEW.tax_rule_id;
 SELECT c.minor_unit INTO currency_minor_unit FROM currency c WHERE c.code=receipt.currency;
 SELECT id INTO selected_policy FROM config_rule WHERE organization_id=NEW.organization_id AND key='finance.service_allocation' AND archived_at IS NULL AND lifecycle IN('ACTIVE','RETIRED')
  AND effective_from<=job.completed_at AND(effective_to IS NULL OR effective_to>job.completed_at)
  AND((scope_type='organization' AND scope_id IS NULL) OR(scope_type='property' AND scope_id=receipt.property_id))
  ORDER BY CASE WHEN scope_type='property' THEN 2 ELSE 1 END DESC,effective_from DESC,version DESC LIMIT 1;
 SELECT id INTO selected_tax FROM config_rule WHERE organization_id=NEW.organization_id AND key='finance.tax' AND archived_at IS NULL AND lifecycle IN('ACTIVE','RETIRED')
  AND effective_from<=job.completed_at AND(effective_to IS NULL OR effective_to>job.completed_at)
  AND((scope_type='organization' AND scope_id IS NULL) OR(scope_type='property' AND scope_id=receipt.property_id))
  ORDER BY CASE WHEN scope_type='property' THEN 2 ELSE 1 END DESC,effective_from DESC,version DESC LIMIT 1;
 IF subject.id IS NULL OR receipt.id IS NULL OR NEW.version<>COALESCE(previous.version,0)+1 OR NEW.previous_admission_id IS DISTINCT FROM previous.id
  OR NEW.created_at<subject.created_at OR NEW.created_at<previous.created_at OR NEW.created_at>clock_timestamp()
  OR policy.id IS NULL OR taxes.id IS NULL OR policy.id IS DISTINCT FROM selected_policy OR taxes.id IS DISTINCT FROM selected_tax
  OR policy.value->>'source' IS DISTINCT FROM 'COMPLETED_SERVICE_COLLECTION' OR policy.value->>'rule_selection' IS DISTINCT FROM 'AT_ACTUAL_SERVICE_COMPLETION'
  OR COALESCE(policy.value->>'ownership_basis','') NOT IN('RESERVATION_SNAPSHOT','CURRENT_PROPERTY_OWNERS_AT_ADMISSION')
  OR EXISTS(SELECT 1 FROM service_allocation_provider_binding WHERE organization_id=NEW.organization_id AND idempotency_key=NEW.idempotency_key)
  OR NEW.snapshot->>'schemaVersion' IS DISTINCT FROM '1' OR NEW.snapshot->'source'->>'kind' IS DISTINCT FROM 'COMPLETED_SERVICE_COLLECTION'
  OR NEW.snapshot->'source'->>'collectionId' IS DISTINCT FROM receipt.id::text
  OR NEW.snapshot->'source'->>'transactionId' IS DISTINCT FROM receipt.transaction_id::text OR NEW.snapshot->'source'->>'taskId' IS DISTINCT FROM receipt.task_id::text
  OR NEW.snapshot->'source'->>'propertyId' IS DISTINCT FROM receipt.property_id::text OR NEW.snapshot->'source'->>'reservationId' IS DISTINCT FROM receipt.reservation_id::text
  OR NEW.snapshot->'source'->>'completionEventId' IS DISTINCT FROM subject.completion_event_id::text
  OR (NEW.snapshot->'source'->>'completedAt')::timestamptz IS DISTINCT FROM job.completed_at
  OR (NEW.snapshot->'source'->>'recordedAt')::timestamptz IS DISTINCT FROM receipt.recorded_at
  OR NEW.snapshot->'source'->>'currencyMinorUnit' IS DISTINCT FROM currency_minor_unit::text
  OR NEW.snapshot->'source'->>'performedByPersonId' IS DISTINCT FROM job.completed_by_person_id::text
  OR NEW.snapshot->'source'->'amount' IS DISTINCT FROM jsonb_build_object('amount',to_char(receipt.amount,'FM9999999999999990.00'),'currency',receipt.currency)
  OR NEW.snapshot->'rules'->'allocation'->>'id' IS DISTINCT FROM policy.id::text OR NEW.snapshot->'rules'->'allocation'->>'version' IS DISTINCT FROM policy.version::text
  OR NEW.snapshot->'rules'->'allocation' IS DISTINCT FROM jsonb_build_object('id',policy.id,'version',policy.version,'source',policy.value->>'source','ruleSelection',policy.value->>'rule_selection','ownershipBasis',policy.value->>'ownership_basis')
  OR NEW.snapshot->'rules'->'tax' IS DISTINCT FROM jsonb_build_object('id',taxes.id,'version',taxes.version)
  OR currency_minor_unit IS NULL OR currency_minor_unit>2
  OR NOT EXISTS(SELECT 1 FROM financial_transaction t WHERE t.organization_id=NEW.organization_id AND t.id=receipt.transaction_id AND t.sealed
    AND NOT EXISTS(SELECT 1 FROM financial_transaction reversal WHERE reversal.organization_id=t.organization_id AND reversal.reverses_transaction_id=t.id))
 THEN RAISE EXCEPTION 'service admission requires its original source, current selected policies and immutable consecutive snapshot'; END IF;
 IF (SELECT count(*) FROM jsonb_array_elements(policy.value->'services') WHERE value->>'service_key'=NEW.service_key)<>1 THEN RAISE EXCEPTION 'unambiguous original service recipe required'; END IF;
 SELECT value INTO recipe FROM jsonb_array_elements(policy.value->'services') WHERE value->>'service_key'=NEW.service_key;
 IF recipe IS NULL OR NEW.snapshot->'recipe' IS DISTINCT FROM recipe OR NEW.snapshot->'parts' IS DISTINCT FROM app_service_allocation_parts(recipe,receipt.amount,receipt.currency)
  OR jsonb_typeof(NEW.snapshot->'taxes') IS DISTINCT FROM 'array'
  OR jsonb_array_length(NEW.snapshot->'taxes')<>jsonb_array_length(recipe->'tax_rule_keys')
  OR (SELECT count(DISTINCT t->>'ruleKey') FROM jsonb_array_elements(NEW.snapshot->'taxes') t)<>jsonb_array_length(recipe->'tax_rule_keys')
 THEN RAISE EXCEPTION 'service admission must conserve exact configured original Money and independent tax decisions'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.snapshot->'parts') p WHERE p->>'beneficiary'='OWNER' AND(p->'amount'->>'amount')::numeric>0) THEN
  IF policy.value->>'ownership_basis'='RESERVATION_SNAPSHOT' THEN expected_owners=receipt.provenance->'reservationFinancialSnapshot'->'rules'->'owners';
  ELSE SELECT jsonb_agg(jsonb_build_object('ownerId',p.owner_id,'ownerName',o.display_name,'shareBps',p.share_bps) ORDER BY p.owner_id) INTO expected_owners
   FROM property_owner p JOIN owner o ON o.organization_id=p.organization_id AND o.id=p.owner_id
   WHERE p.organization_id=NEW.organization_id AND p.property_id=receipt.property_id AND p.archived_at IS NULL AND o.archived_at IS NULL;
  END IF;
  IF expected_owners IS NULL OR jsonb_typeof(expected_owners)<>'array' OR jsonb_array_length(expected_owners)=0
   OR(SELECT sum((o->>'shareBps')::integer) FROM jsonb_array_elements(expected_owners) o)<>10000
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(expected_owners) o WHERE NOT EXISTS(SELECT 1 FROM owner WHERE organization_id=NEW.organization_id AND id=(o->>'ownerId')::uuid))
  THEN RAISE EXCEPTION 'service admission requires the explicitly configured actual ownership evidence'; END IF;
 ELSE expected_owners='[]'::jsonb;
 END IF;
 IF NEW.snapshot->'owners' IS DISTINCT FROM expected_owners THEN RAISE EXCEPTION 'service admission cannot substitute recipients or ownership shares'; END IF;
 FOR assessment IN SELECT value FROM jsonb_array_elements(NEW.snapshot->'taxes') LOOP
  IF NOT(recipe->'tax_rule_keys' ? (assessment->>'ruleKey')) OR assessment->>'policyRuleId' IS DISTINCT FROM taxes.id::text OR assessment->>'policyVersion' IS DISTINCT FROM taxes.version::text
   OR jsonb_typeof(assessment->'amount') IS DISTINCT FROM 'object' OR jsonb_typeof(assessment->'amount'->'amount') IS DISTINCT FROM 'string'
   OR assessment->'amount'->>'currency' IS DISTINCT FROM receipt.currency OR assessment->'amount'->>'amount'!~'^(0|[1-9][0-9]{0,15})(\.[0-9]{1,2})?$'
   OR assessment->'gross' IS DISTINCT FROM NEW.snapshot->'source'->'amount'
  THEN RAISE EXCEPTION 'service admission tax must retain its actual approved decision'; END IF;
  IF (SELECT count(*) FROM jsonb_array_elements(taxes.value->'taxes') t WHERE t->>'key'=assessment->>'ruleKey')<>1 THEN RAISE EXCEPTION 'unambiguous actual service tax required'; END IF;
  SELECT value INTO tax_entry FROM jsonb_array_elements(taxes.value->'taxes') WHERE value->>'key'=assessment->>'ruleKey';
  IF tax_entry->>'currency' IS DISTINCT FROM receipt.currency OR tax_entry->'service_assessment'->>'basis' IS DISTINCT FROM 'ACTUAL_COLLECTED_GROSS'
   OR tax_entry->'service_assessment'->>'rounding' IS DISTINCT FROM 'HALF_UP_AT_LEDGER_PRECISION'
   OR COALESCE(tax_entry->'service_assessment'->>'method','') NOT IN('FIXED','BASIS_POINTS')
  THEN RAISE EXCEPTION 'explicit original service tax treatment required'; END IF;
  IF assessment->>'method' IS DISTINCT FROM tax_entry->'service_assessment'->>'method'
   OR assessment->>'basis' IS DISTINCT FROM tax_entry->'service_assessment'->>'basis'
   OR assessment->>'rounding' IS DISTINCT FROM tax_entry->'service_assessment'->>'rounding'
   OR assessment->'configuredValue' IS DISTINCT FROM (CASE WHEN tax_entry->'service_assessment'->>'method'='FIXED'
    THEN jsonb_build_object('amount',to_char((tax_entry->>'amount')::numeric,'FM9999999999999990.00')) ELSE jsonb_build_object('rateBps',(tax_entry->>'rate_bps')::integer) END)
  THEN RAISE EXCEPTION 'service tax assessment must preserve its original selected method and basis'; END IF;
  expected_tax=CASE WHEN tax_entry->'service_assessment'->>'method'='FIXED' THEN (tax_entry->>'amount')::numeric ELSE round(receipt.amount*(tax_entry->>'rate_bps')::numeric/10000,2) END;
  actual_tax=(assessment->'amount'->>'amount')::numeric;
  IF expected_tax IS NULL OR actual_tax IS NULL OR actual_tax<>expected_tax OR actual_tax<>round(actual_tax,currency_minor_unit)
   OR actual_tax<>(SELECT COALESCE(sum((part->'amount'->>'amount')::numeric),0) FROM jsonb_array_elements(NEW.snapshot->'parts') part WHERE part->>'taxRuleKey'=assessment->>'ruleKey')
  THEN RAISE EXCEPTION 'service admission cannot invent or reprice a tax liability'; END IF;
 END LOOP;
 RETURN NEW;
END $$;
CREATE TRIGGER service_admission_guard BEFORE INSERT ON service_allocation_admission FOR EACH ROW EXECUTE FUNCTION app_service_admission_guard();

CREATE FUNCTION app_service_provider_part_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE admission service_allocation_admission; binding service_allocation_provider_binding; latest uuid; retained jsonb; source_amount numeric; source_currency text; source_journal uuid; source_party uuid;
BEGIN
 SELECT * INTO admission FROM service_allocation_admission WHERE organization_id=NEW.organization_id AND id=NEW.admission_id;
 SELECT * INTO binding FROM service_allocation_provider_binding WHERE organization_id=NEW.organization_id AND id=NEW.binding_id;
 SELECT id INTO latest FROM service_allocation_provider_binding WHERE organization_id=NEW.organization_id AND supplier_invoice_line_id IS NOT DISTINCT FROM binding.supplier_invoice_line_id AND employee_cost_id IS NOT DISTINCT FROM binding.employee_cost_id ORDER BY version DESC LIMIT 1;
 SELECT value INTO retained FROM jsonb_array_elements(admission.snapshot->'providerCosts') WHERE value->>'componentKey'=NEW.component_key;
 IF binding.supplier_invoice_line_id IS NOT NULL THEN
  SELECT l.amount,l.currency,r.transaction_id,i.supplier_id INTO source_amount,source_currency,source_journal,source_party
   FROM supplier_invoice_line l JOIN supplier_invoice_recognition_line r ON r.organization_id=l.organization_id AND r.invoice_line_id=l.id
   JOIN supplier_invoice_revision v ON v.organization_id=l.organization_id AND v.id=l.revision_id
   JOIN supplier_invoice i ON i.organization_id=v.organization_id AND i.id=v.invoice_id
   WHERE l.organization_id=NEW.organization_id AND l.id=binding.supplier_invoice_line_id;
 ELSE
  SELECT l.amount,l.currency,r.transaction_id,c.person_id INTO source_amount,source_currency,source_journal,source_party
   FROM employee_compensation_cost l JOIN employee_compensation_recognition_line r ON r.organization_id=l.organization_id AND r.cost_id=l.id
   JOIN employee_compensation_claim c ON c.organization_id=l.organization_id AND c.id=l.claim_id
   WHERE l.organization_id=NEW.organization_id AND l.id=binding.employee_cost_id;
 END IF;
 IF admission.id IS NULL OR binding.id IS NULL OR admission.source_id<>binding.source_id OR binding.state<>'ATTACHED' OR binding.id IS DISTINCT FROM latest
  OR binding.created_at>admission.created_at OR retained->>'bindingId' IS DISTINCT FROM binding.id::text
  OR retained->>'costId' IS DISTINCT FROM COALESCE(binding.supplier_invoice_line_id,binding.employee_cost_id)::text
  OR retained->>'sourceKind' IS DISTINCT FROM (CASE WHEN binding.supplier_invoice_line_id IS NOT NULL THEN 'SUPPLIER_INVOICE_LINE' ELSE 'EMPLOYEE_COST' END)
  OR source_journal IS NULL OR retained->>'transactionId' IS DISTINCT FROM source_journal::text OR retained->>'partyId' IS DISTINCT FROM source_party::text
  OR retained->'amount' IS DISTINCT FROM jsonb_build_object('amount',to_char(source_amount,'FM9999999999999990.00'),'currency',source_currency)
  OR NOT EXISTS(SELECT 1 FROM financial_transaction t WHERE t.organization_id=NEW.organization_id AND t.id=source_journal AND t.sealed AND NOT EXISTS(SELECT 1 FROM financial_transaction reversal WHERE reversal.organization_id=t.organization_id AND reversal.reverses_transaction_id=t.id))
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(admission.snapshot->'parts') part WHERE part->>'key'=NEW.component_key
   AND part->>'beneficiary'=CASE WHEN binding.supplier_invoice_line_id IS NOT NULL THEN 'SUPPLIER' ELSE 'PERSON' END AND part->'amount'=retained->'amount' AND source_amount>0)
 THEN RAISE EXCEPTION 'service provider part must bind its actual current native source and exact retained amount'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER service_provider_part_guard BEFORE INSERT ON service_allocation_provider_part FOR EACH ROW EXECUTE FUNCTION app_service_provider_part_guard();

CREATE FUNCTION app_service_source_audit_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE receipt cash_collection;
BEGIN
 SELECT * INTO receipt FROM cash_collection WHERE organization_id=NEW.organization_id AND id=NEW.cash_collection_id;
 IF NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=NEW.organization_id AND a.actor_id=NEW.created_by AND a.resource_type='service_allocation' AND a.resource_id=NEW.id
  AND a.property_scope_id=receipt.property_id AND a.action='service_allocation.source_registered' AND a.after->>'sourceId'=NEW.id::text
  AND a.after->>'collectionId'=receipt.id::text AND a.after->>'completionEventId'=NEW.completion_event_id::text AND a.occurred_at=NEW.created_at)
 THEN RAISE EXCEPTION 'service source and its actual-source audit must commit atomically'; END IF; RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER service_source_atomic_audit AFTER INSERT ON service_financial_source DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_service_source_audit_guard();

CREATE FUNCTION app_service_provider_audit_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM audit_log a JOIN service_financial_source s ON s.organization_id=a.organization_id AND s.id=a.resource_id JOIN cash_collection c ON c.organization_id=s.organization_id AND c.id=s.cash_collection_id
  WHERE a.organization_id=NEW.organization_id AND a.actor_id=NEW.created_by AND a.resource_type='service_allocation' AND a.resource_id=NEW.source_id AND a.property_scope_id=c.property_id
  AND a.action=CASE WHEN NEW.state='ATTACHED' THEN 'service_allocation.provider_attached' ELSE 'service_allocation.provider_released' END
  AND a.after->>'bindingId'=NEW.id::text AND a.after->>'sourceId'=NEW.source_id::text AND a.after->>'version'=NEW.version::text
  AND a.after->>'idempotencyKey'=NEW.idempotency_key::text AND a.after->>'requestHash'=NEW.request_hash AND a.reason=NEW.reason AND a.occurred_at=NEW.created_at)
 THEN RAISE EXCEPTION 'service provider binding and native-result audit must commit atomically'; END IF; RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER service_provider_atomic_audit AFTER INSERT ON service_allocation_provider_binding DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_service_provider_audit_guard();

CREATE FUNCTION app_service_admission_audit_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM audit_log a JOIN service_financial_source s ON s.organization_id=a.organization_id AND s.id=a.resource_id JOIN cash_collection c ON c.organization_id=s.organization_id AND c.id=s.cash_collection_id
  WHERE a.organization_id=NEW.organization_id AND a.actor_id=NEW.created_by AND a.resource_type='service_allocation' AND a.resource_id=NEW.source_id AND a.property_scope_id=c.property_id
  AND a.action='service_allocation.admitted' AND a.after->>'admissionId'=NEW.id::text AND a.after->>'sourceId'=NEW.source_id::text AND a.after->>'version'=NEW.version::text
  AND a.after->>'idempotencyKey'=NEW.idempotency_key::text AND a.after->>'requestHash'=NEW.request_hash AND a.after->>'reviewFingerprint'=NEW.review_fingerprint
  AND a.reason=NEW.reason AND a.occurred_at=NEW.created_at)
  OR jsonb_typeof(NEW.snapshot->'providerCosts') IS DISTINCT FROM 'array'
  OR (SELECT count(*) FROM service_allocation_provider_part WHERE organization_id=NEW.organization_id AND admission_id=NEW.id)<>jsonb_array_length(NEW.snapshot->'providerCosts')
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.snapshot->'providerCosts') cost WHERE NOT EXISTS(SELECT 1 FROM service_allocation_provider_part part WHERE part.organization_id=NEW.organization_id AND part.admission_id=NEW.id AND part.binding_id::text=cost->>'bindingId' AND part.component_key=cost->>'componentKey'))
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.snapshot->'parts') component WHERE component->>'beneficiary' IN('SUPPLIER','PERSON') AND (component->'amount'->>'amount')::numeric>0
   AND NOT EXISTS(SELECT 1 FROM service_allocation_provider_part part WHERE part.organization_id=NEW.organization_id AND part.admission_id=NEW.id AND part.component_key=component->>'key'))
 THEN RAISE EXCEPTION 'service admission, complete actual provider references and audit must commit atomically'; END IF; RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER service_admission_atomic_audit AFTER INSERT ON service_allocation_admission DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_service_admission_audit_guard();

COMMIT;
