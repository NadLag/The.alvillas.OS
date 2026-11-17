-- Derived original receipt identity is additive. Historical declarations are
-- retained without backfills; closed native expense families remain reusable.
ALTER TABLE expense_purchase ADD COLUMN receipt_document_id uuid;
ALTER TABLE expense_purchase ADD COLUMN receipt_sha256 char(64);
ALTER TABLE expense_purchase ADD CONSTRAINT expense_purchase_document_fk FOREIGN KEY(organization_id,receipt_document_id) REFERENCES document(organization_id,id) ON DELETE RESTRICT;
CREATE INDEX expense_purchase_receipt_document_idx ON expense_purchase(organization_id,receipt_document_id);
CREATE INDEX expense_purchase_receipt_sha_idx ON expense_purchase(organization_id,receipt_sha256);

CREATE FUNCTION app_expense_purchase_original_identity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE version document_version; admission document_admission;
BEGIN
 SELECT * INTO STRICT version FROM document_version WHERE organization_id=NEW.organization_id AND id=NEW.receipt_version_id;
 SELECT * INTO STRICT admission FROM document_admission WHERE organization_id=NEW.organization_id AND id=version.admission_id;
 IF NEW.receipt_document_id IS NOT NULL AND NEW.receipt_document_id<>version.document_id OR NEW.receipt_sha256 IS NOT NULL AND NEW.receipt_sha256<>admission.sha256
 THEN RAISE EXCEPTION 'expense_purchase_actual_receipt_identity_required' USING ERRCODE='23514'; END IF;
 NEW.receipt_document_id:=version.document_id;NEW.receipt_sha256:=admission.sha256;
 RETURN NEW;
END $$;
CREATE TRIGGER expense_purchase_original_identity_guard BEFORE INSERT ON expense_purchase FOR EACH ROW EXECUTE FUNCTION app_expense_purchase_original_identity();

CREATE FUNCTION app_assert_expense_purchase_original_receipt(org_uuid uuid,expense_uuid uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE source expense_purchase; version document_version; receipt_hash text; current_state text; identity_key text;
BEGIN
 SELECT p.* INTO source FROM expense_purchase p WHERE p.organization_id=org_uuid AND p.expense_id=expense_uuid;
 IF source.expense_id IS NULL OR source.root_expense_id<>source.expense_id THEN RETURN; END IF;
 SELECT e.state INTO STRICT current_state FROM expense e WHERE e.organization_id=org_uuid AND e.id=expense_uuid;
 IF current_state IN('REJECTED','VOIDED') THEN RETURN; END IF;
 SELECT * INTO STRICT version FROM document_version WHERE organization_id=org_uuid AND id=source.receipt_version_id;
 SELECT a.sha256 INTO STRICT receipt_hash FROM document_admission a WHERE a.organization_id=org_uuid AND a.id=version.admission_id;
 FOR identity_key IN SELECT k FROM unnest(ARRAY['document:'||version.document_id::text,'sha:'||receipt_hash]) k ORDER BY k LOOP
  PERFORM pg_advisory_xact_lock(hashtextextended(org_uuid::text||':expense-original-receipt:'||identity_key,0));
 END LOOP;
 IF EXISTS(SELECT 1 FROM expense_purchase other JOIN expense e ON e.organization_id=other.organization_id AND e.id=other.expense_id
  JOIN document_version v ON v.organization_id=other.organization_id AND v.id=other.receipt_version_id
  JOIN document_admission a ON a.organization_id=v.organization_id AND a.id=v.admission_id
  WHERE other.organization_id=org_uuid AND other.expense_id<>expense_uuid AND other.expense_id=other.root_expense_id AND e.state NOT IN('REJECTED','VOIDED')
   AND(other.receipt_document_id=version.document_id OR other.receipt_sha256=receipt_hash OR other.receipt_document_id IS NULL AND(v.document_id=version.document_id OR a.sha256=receipt_hash)))
 THEN RAISE EXCEPTION 'expense_purchase_original_receipt_already_active' USING ERRCODE='23514'; END IF;
END $$;
CREATE FUNCTION app_expense_purchase_original_receipt_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='expense' THEN PERFORM app_assert_expense_purchase_original_receipt(NEW.organization_id,NEW.id);
 ELSE PERFORM app_assert_expense_purchase_original_receipt(NEW.organization_id,NEW.expense_id); END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER expense_purchase_original_receipt_guard AFTER INSERT ON expense_purchase DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_expense_purchase_original_receipt_guard();
CREATE CONSTRAINT TRIGGER expense_original_receipt_guard AFTER INSERT OR UPDATE ON expense DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_expense_purchase_original_receipt_guard();

-- Corrections retain their original admitted proof and exact source family.
CREATE OR REPLACE FUNCTION app_expense_purchase_birth() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e expense; d document; v document_version; a document_admission;
BEGIN
 SELECT * INTO STRICT e FROM expense WHERE organization_id=NEW.organization_id AND id=NEW.expense_id;
 SELECT * INTO STRICT v FROM document_version WHERE organization_id=NEW.organization_id AND id=NEW.receipt_version_id;
 SELECT * INTO STRICT d FROM document WHERE organization_id=NEW.organization_id AND id=v.document_id;
 SELECT * INTO STRICT a FROM document_admission WHERE organization_id=NEW.organization_id AND id=v.admission_id;
 IF e.created_by<>NEW.created_by OR NOT EXISTS(SELECT 1 FROM expense x WHERE x.organization_id=NEW.organization_id AND x.id=e.id AND x.xmin::text::bigint=mod(pg_current_xact_id()::text::numeric,4294967296)::bigint)
 OR d.kind<>'FILE' OR NOT('financial'=ANY(d.privacy)) OR e.corrects_expense_id IS NULL AND d.archived_at IS NOT NULL
 OR NOT(d.source_kind='PROPERTY' AND d.source_id=e.property_id OR d.source_kind='RESERVATION' AND d.source_id=e.reservation_id)
 OR a.content_type NOT IN('application/pdf','image/jpeg','image/png','image/webp')
 OR e.corrects_expense_id IS NULL AND EXISTS(SELECT 1 FROM document_version n WHERE n.organization_id=NEW.organization_id AND n.supersedes_id=v.id)
 OR NOT EXISTS(SELECT 1 FROM audit_log l WHERE l.organization_id=NEW.organization_id AND l.resource_type='expense' AND l.resource_id=e.id AND l.action='expense.created' AND l.actor_id=NEW.created_by)
 OR NEW.root_expense_id<>COALESCE((SELECT p.root_expense_id FROM expense_purchase p WHERE p.organization_id=NEW.organization_id AND p.expense_id=e.corrects_expense_id),e.id)
 THEN RAISE EXCEPTION 'expense_purchase_original_evidence_required' USING ERRCODE='23514'; END IF;
 IF e.corrects_expense_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM expense_purchase parent JOIN document_version original ON original.organization_id=parent.organization_id AND original.id=parent.receipt_version_id WHERE parent.organization_id=NEW.organization_id AND parent.expense_id=e.corrects_expense_id AND parent.root_expense_id=NEW.root_expense_id AND parent.funding_kind=NEW.funding_kind AND parent.purchaser_id=NEW.purchaser_id AND parent.supplier_id=NEW.supplier_id AND original.document_id=v.document_id) THEN RAISE EXCEPTION 'expense_purchase_correction_original_family_required' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
