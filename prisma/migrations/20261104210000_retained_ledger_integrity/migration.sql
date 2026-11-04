BEGIN;

-- Retained verification metadata only. No journal, posting or balance is changed.
CREATE TABLE ledger_integrity_source (
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  transaction_id uuid NOT NULL,
  fingerprint char(64) NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (organization_id,transaction_id),
  FOREIGN KEY (organization_id,transaction_id) REFERENCES financial_transaction(organization_id,id) ON DELETE RESTRICT ON UPDATE NO ACTION
);
CREATE TABLE ledger_integrity_run (
  id uuid PRIMARY KEY DEFAULT app_uuid_v7(),
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  "on" date NOT NULL,
  policy_rule_id uuid NOT NULL,
  created_by uuid NOT NULL,
  checked_at timestamptz NOT NULL,
  passed boolean NOT NULL,
  report jsonb NOT NULL CHECK (jsonb_typeof(report)='object' AND report @> jsonb_build_object('version',1,'passed',passed)),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (organization_id,policy_rule_id) REFERENCES config_rule(organization_id,id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  FOREIGN KEY (organization_id,created_by) REFERENCES user_account(organization_id,id) ON DELETE RESTRICT ON UPDATE NO ACTION
);
CREATE UNIQUE INDEX ledger_integrity_run_org_id_unique ON ledger_integrity_run(organization_id,id);
CREATE UNIQUE INDEX ledger_integrity_run_occurrence_unique ON ledger_integrity_run(organization_id,policy_rule_id,"on");
CREATE INDEX ledger_integrity_run_history_idx ON ledger_integrity_run(organization_id,created_at,id);

CREATE FUNCTION app_ledger_integrity_journal_hash(p_organization uuid,p_transaction uuid)
RETURNS text LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
  SELECT encode(sha256(convert_to(jsonb_build_object('journal',to_jsonb(t),'postings',
    coalesce((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id) FROM posting p WHERE p.organization_id=t.organization_id AND p.transaction_id=t.id),'[]'::jsonb))::text,'UTF8')),'hex')
  FROM financial_transaction t WHERE t.organization_id=p_organization AND t.id=p_transaction
$$;
CREATE FUNCTION app_guard_ledger_integrity_source()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF NEW.fingerprint IS DISTINCT FROM app_ledger_integrity_journal_hash(NEW.organization_id,NEW.transaction_id)
    OR NOT EXISTS(SELECT 1 FROM financial_transaction t WHERE t.organization_id=NEW.organization_id AND t.id=NEW.transaction_id AND t.sealed) THEN
    RAISE EXCEPTION 'ledger integrity baseline must match the original sealed journal';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER ledger_integrity_source_native BEFORE INSERT ON ledger_integrity_source FOR EACH ROW EXECUTE FUNCTION app_guard_ledger_integrity_source();
CREATE TRIGGER ledger_integrity_source_no_update BEFORE UPDATE ON ledger_integrity_source FOR EACH ROW EXECUTE FUNCTION app_prevent_ledger_mutation();
CREATE TRIGGER ledger_integrity_source_no_delete BEFORE DELETE ON ledger_integrity_source FOR EACH ROW EXECUTE FUNCTION app_prevent_ledger_mutation();
CREATE TRIGGER ledger_integrity_run_no_update BEFORE UPDATE ON ledger_integrity_run FOR EACH ROW EXECUTE FUNCTION app_prevent_ledger_mutation();
CREATE TRIGGER ledger_integrity_run_no_delete BEFORE DELETE ON ledger_integrity_run FOR EACH ROW EXECUTE FUNCTION app_prevent_ledger_mutation();

ALTER TABLE ledger_integrity_source ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_integrity_source FORCE ROW LEVEL SECURITY;
CREATE POLICY ledger_integrity_source_tenant_isolation ON ledger_integrity_source
  USING (organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
  WITH CHECK (organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
ALTER TABLE ledger_integrity_run ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_integrity_run FORCE ROW LEVEL SECURITY;
CREATE POLICY ledger_integrity_run_tenant_isolation ON ledger_integrity_run
  USING (organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
  WITH CHECK (organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);

COMMIT;
