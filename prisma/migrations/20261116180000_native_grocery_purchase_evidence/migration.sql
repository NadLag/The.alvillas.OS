-- New bindings require the original native purchaser/supplier/funding declaration.
-- Keep historical receipt associations and admit the existing private archive.
ALTER TABLE grocery_expense_binding ALTER COLUMN receipt_id DROP NOT NULL;
ALTER TABLE grocery_expense_binding ADD COLUMN receipt_version_id uuid;
ALTER TABLE grocery_expense_binding ADD CONSTRAINT grocery_expense_binding_document_fk FOREIGN KEY(organization_id,receipt_version_id) REFERENCES document_version(organization_id,id) ON DELETE RESTRICT;
ALTER TABLE grocery_expense_binding ADD CONSTRAINT grocery_expense_binding_one_receipt CHECK((receipt_id IS NULL)<>(receipt_version_id IS NULL));
CREATE OR REPLACE FUNCTION app_grocery_expense_binding_birth() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM service_order o JOIN expense e ON e.organization_id=o.organization_id AND e.id=NEW.expense_id
  JOIN expense_purchase p ON p.organization_id=e.organization_id AND p.expense_id=e.id
  JOIN financial_transaction j ON j.organization_id=e.organization_id AND j.id=e.transaction_id
  JOIN document_version v ON v.organization_id=p.organization_id AND v.id=p.receipt_version_id
  JOIN document d ON d.organization_id=v.organization_id AND d.id=v.document_id
  WHERE o.organization_id=NEW.organization_id AND o.id=NEW.order_id AND o.version=NEW.order_version AND o.state NOT IN('CANCELLED','REJECTED')
   AND jsonb_typeof(o.catalog_snapshot#>'{order_terms,grocery_order}')='object' AND e.property_id=o.property_id
   AND(e.reservation_id IS NULL OR e.reservation_id=o.reservation_id) AND e.state='POSTED' AND j.sealed
   AND j.reverses_transaction_id IS NULL AND NOT EXISTS(SELECT 1 FROM financial_transaction r WHERE r.organization_id=j.organization_id AND r.reverses_transaction_id=j.id)
   AND d.archived_at IS NULL AND NOT EXISTS(SELECT 1 FROM document_version n WHERE n.organization_id=v.organization_id AND n.supersedes_id=v.id)
   AND(NEW.receipt_version_id=p.receipt_version_id OR EXISTS(SELECT 1 FROM financial_attachment f JOIN financial_attachment_admission a ON a.organization_id=f.organization_id AND a.id=f.id WHERE f.organization_id=e.organization_id AND f.id=NEW.receipt_id AND f.transaction_id=j.id AND a.kind IN('RECEIPT','INVOICE') AND NOT EXISTS(SELECT 1 FROM financial_attachment n WHERE n.organization_id=f.organization_id AND n.supersedes_id=f.id))))
  OR NOT EXISTS(SELECT 1 FROM audit_log l WHERE l.organization_id=NEW.organization_id AND l.actor_id=NEW.created_by
   AND l.action='service.grocery.expense_bound' AND l.resource_type='service_order' AND l.resource_id=NEW.order_id
   AND l.after->>'bindingId'=NEW.id::text AND l.after->>'expenseId'=NEW.expense_id::text AND l.after->>'receiptId'=COALESCE(NEW.receipt_id,NEW.receipt_version_id)::text
   AND l.reason=NEW.reason AND l.occurred_at=NEW.created_at AND l.xmin::text=NEW.xmin::text AND l.xmin::text=pg_current_xact_id()::xid::text)
 THEN RAISE EXCEPTION 'grocery_expense_requires_original_posted_purchase_receipt_and_atomic_audit';END IF;
 RETURN NULL;
END $$;
