-- Additive original request and receipt associations. No existing order,
-- financial transaction, posting, receipt or migration is rewritten.
CREATE TABLE grocery_expense_binding(
 id uuid PRIMARY KEY DEFAULT app_uuid_v7(),organization_id uuid NOT NULL,order_id uuid NOT NULL,order_version integer NOT NULL,
 expense_id uuid NOT NULL,receipt_id uuid NOT NULL,command_key uuid NOT NULL,command_hash char(64) NOT NULL,
 created_by uuid NOT NULL,created_at timestamptz(6) NOT NULL,reason text NOT NULL,
 CONSTRAINT grocery_expense_binding_org_id_key UNIQUE(organization_id,id),
 CONSTRAINT grocery_expense_binding_expense_key UNIQUE(organization_id,expense_id),
 CONSTRAINT grocery_expense_binding_command_key UNIQUE(organization_id,command_key),
 CONSTRAINT grocery_expense_binding_org_fk FOREIGN KEY(organization_id) REFERENCES organization(id) ON DELETE RESTRICT,
 CONSTRAINT grocery_expense_binding_order_fk FOREIGN KEY(organization_id,order_id) REFERENCES service_order(organization_id,id) ON DELETE RESTRICT,
 CONSTRAINT grocery_expense_binding_expense_fk FOREIGN KEY(organization_id,expense_id) REFERENCES expense(organization_id,id) ON DELETE RESTRICT,
 CONSTRAINT grocery_expense_binding_receipt_fk FOREIGN KEY(organization_id,receipt_id) REFERENCES financial_attachment(organization_id,id) ON DELETE RESTRICT,
 CONSTRAINT grocery_expense_binding_actor_fk FOREIGN KEY(organization_id,created_by) REFERENCES user_account(organization_id,id) ON DELETE RESTRICT,
 CONSTRAINT grocery_expense_binding_content_check CHECK(order_version>0 AND length(btrim(reason)) BETWEEN 6 AND 500 AND command_hash~'^[a-f0-9]{64}$')
);
CREATE INDEX grocery_expense_binding_order_idx ON grocery_expense_binding(organization_id,order_id,id);
ALTER TABLE grocery_expense_binding ENABLE ROW LEVEL SECURITY;
ALTER TABLE grocery_expense_binding FORCE ROW LEVEL SECURITY;
CREATE POLICY grocery_expense_binding_tenant_isolation ON grocery_expense_binding
 USING(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid)
 WITH CHECK(organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid);
CREATE TRIGGER grocery_expense_binding_immutable BEFORE UPDATE OR DELETE ON grocery_expense_binding
 FOR EACH ROW EXECUTE FUNCTION app_onboarding_append_only();

CREATE FUNCTION app_guard_grocery_order_request() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item jsonb;declared boolean;
BEGIN
 declared:=jsonb_typeof(NEW.catalog_snapshot#>'{order_terms,grocery_order}')='object';
 IF coalesce(declared,false) IS DISTINCT FROM (NEW.request_snapshot ? 'groceryItems') THEN RAISE EXCEPTION 'grocery_original_items_required';END IF;
 IF coalesce(declared,false) THEN
  IF coalesce(jsonb_typeof(NEW.request_snapshot->'groceryItems')<>'array' OR jsonb_array_length(NEW.request_snapshot->'groceryItems') NOT BETWEEN 1 AND 100,true) THEN RAISE EXCEPTION 'grocery_original_items_required';END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(NEW.request_snapshot->'groceryItems') LOOP
   IF coalesce(jsonb_typeof(item)<>'object' OR jsonb_typeof(item->'name')<>'string' OR length(btrim(item->>'name')) NOT BETWEEN 1 AND 240
    OR jsonb_typeof(item->'quantity')<>'string' OR NOT(item->>'quantity'~'^(0|[1-9][0-9]{0,11})(\.[0-9]{1,6})?$')
    OR (item->>'quantity')::numeric<=0 OR jsonb_typeof(item->'unit')<>'string' OR length(btrim(item->>'unit')) NOT BETWEEN 1 AND 80
    OR item ? 'notes' AND(jsonb_typeof(item->'notes')<>'string' OR length(item->>'notes')>500)
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(item) k WHERE k NOT IN('name','quantity','unit','notes')),true)
   THEN RAISE EXCEPTION 'grocery_original_items_invalid';END IF;
  END LOOP;
  IF NEW.task_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM operation_task t WHERE t.organization_id=NEW.organization_id AND t.id=NEW.task_id AND t.type=NEW.catalog_snapshot#>>'{order_terms,grocery_order,task_type}') THEN RAISE EXCEPTION 'grocery_original_task_type_required';END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER grocery_order_request_guard BEFORE INSERT OR UPDATE ON service_order FOR EACH ROW EXECUTE FUNCTION app_guard_grocery_order_request();

CREATE FUNCTION app_grocery_expense_binding_birth() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM service_order o JOIN expense e ON e.organization_id=o.organization_id AND e.id=NEW.expense_id
  JOIN financial_transaction j ON j.organization_id=e.organization_id AND j.id=e.transaction_id
  JOIN financial_attachment f ON f.organization_id=e.organization_id AND f.id=NEW.receipt_id AND f.transaction_id=j.id
  JOIN financial_attachment_admission a ON a.organization_id=f.organization_id AND a.id=f.id
  WHERE o.organization_id=NEW.organization_id AND o.id=NEW.order_id AND o.version=NEW.order_version AND o.state NOT IN('CANCELLED','REJECTED')
   AND jsonb_typeof(o.catalog_snapshot#>'{order_terms,grocery_order}')='object' AND e.property_id=o.property_id
   AND(e.reservation_id IS NULL OR e.reservation_id=o.reservation_id) AND e.state='POSTED' AND j.sealed
   AND j.reverses_transaction_id IS NULL AND NOT EXISTS(SELECT 1 FROM financial_transaction r WHERE r.organization_id=j.organization_id AND r.reverses_transaction_id=j.id)
   AND a.kind IN('RECEIPT','INVOICE') AND NOT EXISTS(SELECT 1 FROM financial_attachment n WHERE n.organization_id=f.organization_id AND n.supersedes_id=f.id))
  OR NOT EXISTS(SELECT 1 FROM audit_log l WHERE l.organization_id=NEW.organization_id AND l.actor_id=NEW.created_by
   AND l.action='service.grocery.expense_bound' AND l.resource_type='service_order' AND l.resource_id=NEW.order_id
   AND l.after->>'bindingId'=NEW.id::text AND l.after->>'expenseId'=NEW.expense_id::text AND l.after->>'receiptId'=NEW.receipt_id::text
   AND l.reason=NEW.reason AND l.occurred_at=NEW.created_at AND l.xmin::text=NEW.xmin::text AND l.xmin::text=pg_current_xact_id()::xid::text)
 THEN RAISE EXCEPTION 'grocery_expense_requires_original_posted_receipt_and_atomic_audit';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER grocery_expense_binding_birth_guard AFTER INSERT ON grocery_expense_binding
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_grocery_expense_binding_birth();
