-- An approved correction keeps the same original receipt reserved even after
-- its original expense has been reversed. Fully closed families remain reusable.
CREATE OR REPLACE FUNCTION app_assert_expense_purchase_original_receipt(org_uuid uuid,expense_uuid uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE source expense_purchase; version document_version; receipt_hash text; current_state text; identity_key text;
BEGIN
 SELECT p.* INTO source FROM expense_purchase p WHERE p.organization_id=org_uuid AND p.expense_id=expense_uuid;
 IF source.expense_id IS NULL THEN RETURN; END IF;
 SELECT p.* INTO STRICT source FROM expense_purchase p WHERE p.organization_id=org_uuid AND p.expense_id=source.root_expense_id;
 SELECT e.state INTO STRICT current_state FROM expense e WHERE e.organization_id=org_uuid AND e.id=source.root_expense_id;
 IF current_state IN('REJECTED','VOIDED') AND NOT EXISTS(SELECT 1 FROM expense_purchase family JOIN expense active ON active.organization_id=family.organization_id AND active.id=family.expense_id WHERE family.organization_id=org_uuid AND family.root_expense_id=source.root_expense_id AND active.state='POSTED') THEN RETURN; END IF;
 SELECT * INTO STRICT version FROM document_version WHERE organization_id=org_uuid AND id=source.receipt_version_id;
 SELECT a.sha256 INTO STRICT receipt_hash FROM document_admission a WHERE a.organization_id=org_uuid AND a.id=version.admission_id;
 FOR identity_key IN SELECT k FROM unnest(ARRAY['document:'||version.document_id::text,'sha:'||receipt_hash]) k ORDER BY k LOOP
  PERFORM pg_advisory_xact_lock(hashtextextended(org_uuid::text||':expense-original-receipt:'||identity_key,0));
 END LOOP;
 IF EXISTS(SELECT 1 FROM expense_purchase other JOIN expense e ON e.organization_id=other.organization_id AND e.id=other.expense_id
  JOIN document_version v ON v.organization_id=other.organization_id AND v.id=other.receipt_version_id
  JOIN document_admission a ON a.organization_id=v.organization_id AND a.id=v.admission_id
  WHERE other.organization_id=org_uuid AND other.root_expense_id<>source.root_expense_id AND other.expense_id=other.root_expense_id
   AND(e.state NOT IN('REJECTED','VOIDED') OR EXISTS(SELECT 1 FROM expense_purchase family JOIN expense active ON active.organization_id=family.organization_id AND active.id=family.expense_id WHERE family.organization_id=org_uuid AND family.root_expense_id=other.root_expense_id AND active.state='POSTED'))
   AND(other.receipt_document_id=version.document_id OR other.receipt_sha256=receipt_hash OR other.receipt_document_id IS NULL AND(v.document_id=version.document_id OR a.sha256=receipt_hash)))
 THEN RAISE EXCEPTION 'expense_purchase_original_receipt_already_active' USING ERRCODE='23514'; END IF;
END $$;
