-- Forward correction: qualify the original JSON entry independently of the PL/pgSQL movement variable.
-- Goods receiving reuses native movements, accounting sources and durable outbox receipts.
-- No financial facts, balances, source rows or previous migrations are changed.
CREATE OR REPLACE FUNCTION app_inventory_purchase_receipt_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p jsonb; source jsonb; draft jsonb; source_kind text; source_id uuid; source_root uuid;
 journal_id uuid; source_property uuid; source_reservation uuid; original_amount numeric; original_currency text;
 original_root uuid; original_actor uuid; nonce uuid; receipt_id uuid; receipt_sha text; movement jsonb; leg jsonb;
 native_movement inventory_movement; original_xid xid; expected_lines integer; actual_lines integer; source_row record;
BEGIN
 IF NEW.type NOT IN('inventory.purchase.received','inventory.purchase.source_received','inventory.purchase.cancelled') AND NEW.idempotency_key NOT LIKE 'inventory-purchase:%' AND NEW.idempotency_key NOT LIKE 'inventory-purchase-source:%' THEN RETURN NULL; END IF;
 p:=NEW.payload;original_actor:=(p->>'actorId')::uuid;nonce:=(p->>'idempotencyKey')::uuid;
 IF p->>'schemaVersion' IS DISTINCT FROM '1' OR p->>'organizationId' IS DISTINCT FROM NEW.organization_id::text OR original_actor IS NULL OR nonce IS NULL THEN RAISE EXCEPTION 'inventory_purchase_original_receipt_required'; END IF;
 SELECT xmin INTO original_xid FROM outbox_event WHERE organization_id=NEW.organization_id AND id=NEW.id;
 IF NEW.type='inventory.purchase.cancelled' THEN
  IF NEW.idempotency_key IS DISTINCT FROM 'inventory-purchase:'||nonce::text OR NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=NEW.organization_id AND a.resource_id=nonce AND a.resource_type='inventory_purchase_command' AND a.action=NEW.type AND a.actor_id=original_actor AND a.after=p AND a.xmin=original_xid) THEN RAISE EXCEPTION 'inventory_purchase_original_cancellation_required'; END IF;
  RETURN NULL;
 END IF;
 source:=p->'source';draft:=p->'draft';source_kind:=source->>'kind';source_id:=(source->>'id')::uuid;source_root:=(source->>'rootId')::uuid;journal_id:=(source->>'transactionId')::uuid;receipt_id:=(source->>'receiptId')::uuid;receipt_sha:=source->>'receiptSha256';
 IF source_kind NOT IN('EXPENSE','SUPPLIER_INVOICE_LINE') OR source_id IS NULL OR source_root IS NULL OR journal_id IS NULL OR receipt_id IS NULL OR receipt_sha !~ '^[a-f0-9]{64}$'
  OR draft#>>'{source,kind}' IS DISTINCT FROM source_kind OR draft#>>'{source,id}' IS DISTINCT FROM source_id::text OR draft#>>'{source,receiptId}' IS DISTINCT FROM receipt_id::text OR draft#>>'{source,receiptSource}' IS DISTINCT FROM source->>'receiptSource'
  OR NOT EXISTS(SELECT 1 FROM financial_transaction t WHERE t.organization_id=NEW.organization_id AND t.id=journal_id AND t.sealed AND t.reverses_transaction_id IS NULL AND NOT EXISTS(SELECT 1 FROM financial_transaction r WHERE r.organization_id=t.organization_id AND r.reverses_transaction_id=t.id))
 THEN RAISE EXCEPTION 'inventory_purchase_original_financial_source_required'; END IF;
 IF source_kind='EXPENSE' THEN
  SELECT e.transaction_id,e.property_id,e.reservation_id,e.amount,e.currency,COALESCE(ep.root_expense_id,e.corrects_expense_id,e.id) AS root_id INTO source_row FROM expense e LEFT JOIN expense_purchase ep ON ep.organization_id=e.organization_id AND ep.expense_id=e.id WHERE e.organization_id=NEW.organization_id AND e.id=source_id AND e.state='POSTED';
  IF NOT FOUND OR source_row.transaction_id IS DISTINCT FROM journal_id OR source_row.root_id IS DISTINCT FROM source_root THEN RAISE EXCEPTION 'inventory_purchase_original_expense_required'; END IF;
  source_property:=source_row.property_id;source_reservation:=source_row.reservation_id;original_amount:=source_row.amount;original_currency:=source_row.currency;
 ELSE
  SELECT r.transaction_id,l.property_id,l.reservation_id,l.amount,v.currency INTO source_row FROM supplier_invoice_recognition_line r JOIN supplier_invoice_line l ON l.organization_id=r.organization_id AND l.id=r.invoice_line_id JOIN supplier_invoice_revision v ON v.organization_id=l.organization_id AND v.id=l.revision_id WHERE r.organization_id=NEW.organization_id AND r.invoice_line_id=source_id;
  IF NOT FOUND OR source_row.transaction_id IS DISTINCT FROM journal_id OR source_root IS DISTINCT FROM source_id THEN RAISE EXCEPTION 'inventory_purchase_original_invoice_cost_required'; END IF;
  source_property:=source_row.property_id;source_reservation:=source_row.reservation_id;original_amount:=source_row.amount;original_currency:=source_row.currency;
 END IF;
 IF (source->>'propertyId') IS DISTINCT FROM source_property::text OR(source->>'reservationId') IS DISTINCT FROM source_reservation::text OR(source#>>'{amount,amount}')::numeric IS DISTINCT FROM original_amount OR source#>>'{amount,currency}' IS DISTINCT FROM original_currency THEN RAISE EXCEPTION 'inventory_purchase_original_cost_facts_required'; END IF;
 IF source->>'receiptSource'='DOCUMENT_VERSION' THEN
  IF source_kind<>'EXPENSE' OR NOT EXISTS(SELECT 1 FROM expense_purchase ep JOIN document_version v ON v.organization_id=ep.organization_id AND v.id=ep.receipt_version_id JOIN document_admission a ON a.organization_id=v.organization_id AND a.id=v.admission_id WHERE ep.organization_id=NEW.organization_id AND ep.expense_id=source_id AND v.id=receipt_id AND a.sha256=receipt_sha) THEN RAISE EXCEPTION 'inventory_purchase_original_document_receipt_required'; END IF;
 ELSIF source->>'receiptSource'='FINANCIAL_ATTACHMENT' THEN
  IF NOT EXISTS(SELECT 1 FROM financial_attachment f JOIN financial_attachment_admission a ON a.organization_id=f.organization_id AND a.id=f.admission_id WHERE f.organization_id=NEW.organization_id AND f.id=receipt_id AND f.transaction_id=journal_id AND a.kind IN('RECEIPT','INVOICE') AND a.sha256=receipt_sha AND NOT EXISTS(SELECT 1 FROM financial_attachment n WHERE n.organization_id=f.organization_id AND n.supersedes_id=f.id)) THEN RAISE EXCEPTION 'inventory_purchase_original_attachment_required'; END IF;
  IF source_kind='EXPENSE' AND EXISTS(SELECT 1 FROM expense_purchase ep JOIN document_version v ON v.organization_id=ep.organization_id AND v.id=ep.receipt_version_id JOIN document_admission a ON a.organization_id=v.organization_id AND a.id=v.admission_id WHERE ep.organization_id=NEW.organization_id AND ep.expense_id=source_id AND a.sha256<>receipt_sha) THEN RAISE EXCEPTION 'inventory_purchase_original_purchase_receipt_required'; END IF;
 ELSE RAISE EXCEPTION 'inventory_purchase_original_receipt_kind_required'; END IF;
 IF NEW.type='inventory.purchase.received' THEN
  IF NEW.idempotency_key IS DISTINCT FROM 'inventory-purchase:'||nonce::text THEN RAISE EXCEPTION 'inventory_purchase_original_nonce_required'; END IF;
 ELSIF NEW.type='inventory.purchase.source_received' THEN
  IF NEW.idempotency_key IS DISTINCT FROM 'inventory-purchase-source:'||source_kind||':'||source_root::text THEN RAISE EXCEPTION 'inventory_purchase_original_source_key_required'; END IF;
 ELSE RAISE EXCEPTION 'inventory_purchase_original_type_required'; END IF;
 IF NOT EXISTS(SELECT 1 FROM outbox_event e WHERE e.organization_id=NEW.organization_id AND e.type='inventory.purchase.received' AND e.idempotency_key='inventory-purchase:'||nonce::text AND e.payload=p AND e.xmin=original_xid)
  OR NOT EXISTS(SELECT 1 FROM outbox_event e WHERE e.organization_id=NEW.organization_id AND e.type='inventory.purchase.source_received' AND e.idempotency_key='inventory-purchase-source:'||source_kind||':'||source_root::text AND e.payload=p AND e.xmin=original_xid)
  OR NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=NEW.organization_id AND a.action='inventory.purchase.received' AND a.resource_type='inventory_purchase' AND a.resource_id=nonce AND a.actor_id=original_actor AND a.property_scope_id IS NOT DISTINCT FROM source_property AND a.xmin=original_xid)
  OR NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=NEW.organization_id AND a.action='inventory.purchase.financial_source_linked' AND a.resource_type='financial_transaction' AND a.resource_id=journal_id AND a.actor_id=original_actor AND a.after->>'receiptId'=nonce::text AND a.xmin=original_xid)
 THEN RAISE EXCEPTION 'inventory_purchase_atomic_receipt_and_source_audits_required'; END IF;
 expected_lines:=jsonb_array_length(draft->'lines');actual_lines:=jsonb_array_length(p->'movements');IF expected_lines IS NULL OR expected_lines NOT BETWEEN 1 AND 50 OR actual_lines IS DISTINCT FROM expected_lines THEN RAISE EXCEPTION 'inventory_purchase_original_lines_required'; END IF;
 IF(SELECT count(DISTINCT (line->>'itemId',line->>'locationId')) FROM jsonb_array_elements(draft->'lines') line)<>expected_lines OR(SELECT count(DISTINCT entries.value->>'groupId') FROM jsonb_array_elements(p->'movements') AS entries(value))<>actual_lines THEN RAISE EXCEPTION 'inventory_purchase_distinct_native_streams_required'; END IF;
 FOR movement IN SELECT value FROM jsonb_array_elements(p->'movements') LOOP
  IF movement->>'kind' IS DISTINCT FROM 'PURCHASE' OR movement->>'organizationId' IS DISTINCT FROM NEW.organization_id::text OR movement->>'actorId' IS DISTINCT FROM original_actor::text OR jsonb_array_length(movement->'lines')<>1 THEN RAISE EXCEPTION 'inventory_purchase_original_movement_required'; END IF;
  leg:=movement->'lines'->0;SELECT m.* INTO native_movement FROM inventory_movement m WHERE m.organization_id=NEW.organization_id AND m.id=(leg->>'id')::uuid AND m.kind='PURCHASE' AND m.movement_group_id=(movement->>'groupId')::uuid AND m.actor_id=original_actor AND m.xmin=original_xid;
  IF NOT FOUND OR native_movement.item_id::text IS DISTINCT FROM leg->>'itemId' OR native_movement.location_id::text IS DISTINCT FROM leg->>'locationId' OR native_movement.quantity_delta IS DISTINCT FROM(leg->>'quantity')::numeric OR native_movement.quantity_delta<=0 OR native_movement.reserved_quantity_delta<>0 OR native_movement.damaged_quantity_delta<>0
   OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(draft->'lines') line WHERE line->>'itemId'=native_movement.item_id::text AND line->>'locationId'=native_movement.location_id::text AND(line->>'quantity')::numeric=native_movement.quantity_delta)
   OR source_property IS NOT NULL AND EXISTS(SELECT 1 FROM inventory_location l WHERE l.organization_id=NEW.organization_id AND l.id=native_movement.location_id AND l.property_id IS NOT NULL AND l.property_id<>source_property)
  THEN RAISE EXCEPTION 'inventory_purchase_exact_native_movement_required'; END IF;
 END LOOP;
 RETURN NULL;
END $$;
