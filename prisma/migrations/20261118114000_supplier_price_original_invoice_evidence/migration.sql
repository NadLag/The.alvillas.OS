BEGIN;

-- An optional invoice proof extends the original immutable price receipt.
-- Existing versions, source rows, tenant policies and accounting are untouched.
CREATE FUNCTION app_supplier_price_invoice_evidence_complete() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE proof jsonb;draft jsonb;association laundry_actual_invoice;estimate laundry_expected_invoice;
 basis config_rule;published config_rule;native_invoice supplier_invoice;receipt document_version;root document;
 original_price jsonb;changed_price jsonb;changes integer:=0;keys text[];
BEGIN
 IF NEW.type<>'laundry.supplier_price.recorded' OR NOT(NEW.payload->'draft' ? 'evidence') THEN RETURN NULL; END IF;
 draft:=NEW.payload->'draft';proof:=draft->'evidence';
 SELECT array_agg(k ORDER BY k) INTO keys FROM jsonb_object_keys(proof) k;
 IF draft->>'kind'<>'CREATE' OR keys IS DISTINCT FROM ARRAY['associationId','basisVersionId','confirmedUnitPrices','sourceFingerprint']::text[]
  OR proof->'confirmedUnitPrices' IS DISTINCT FROM 'true'::jsonb OR COALESCE(proof->>'sourceFingerprint','')!~'^[a-f0-9]{64}$'
 THEN RAISE EXCEPTION 'supplier_price_original_invoice_confirmation_required'; END IF;
 SELECT * INTO association FROM laundry_actual_invoice a WHERE a.organization_id=NEW.organization_id AND a.id=(proof->>'associationId')::uuid;
 IF association.id IS NULL THEN RAISE EXCEPTION 'supplier_price_original_invoice_required'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text||':supplier-invoice:'||association.invoice_id::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('actual-laundry-invoice:'||NEW.organization_id::text||':'||association.invoice_id::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('laundry:'||NEW.organization_id::text||':'||association.batch_id::text,0));
 SELECT * INTO estimate FROM laundry_expected_invoice e WHERE e.organization_id=NEW.organization_id AND e.id=association.expected_invoice_id;
 SELECT c.* INTO basis FROM supplier_price_list_version v JOIN config_rule c ON c.organization_id=v.organization_id AND c.id=v.config_rule_id
  WHERE v.organization_id=NEW.organization_id AND v.id=(proof->>'basisVersionId')::uuid;
 SELECT c.* INTO published FROM supplier_price_list_version v JOIN config_rule c ON c.organization_id=v.organization_id AND c.id=v.config_rule_id
  WHERE v.organization_id=NEW.organization_id AND v.id=(NEW.payload->>'versionId')::uuid;
 SELECT * INTO native_invoice FROM supplier_invoice i WHERE i.organization_id=NEW.organization_id AND i.id=association.invoice_id;
 SELECT * INTO receipt FROM document_version v WHERE v.organization_id=NEW.organization_id AND v.id=association.receipt_version_id;
 SELECT * INTO root FROM document d WHERE d.organization_id=NEW.organization_id AND d.id=receipt.document_id;
 IF basis.id IS NULL OR published.id IS NULL OR basis.lifecycle='RETIRED' OR estimate.id IS NULL OR native_invoice.id IS NULL OR root.id IS NULL
  OR association.operation='VOID' OR EXISTS(SELECT 1 FROM laundry_actual_invoice a WHERE a.organization_id=NEW.organization_id AND a.supersedes_id=association.id)
  OR native_invoice.archived_at IS NOT NULL OR native_invoice.current_revision_id<>association.revision_id OR root.archived_at IS NOT NULL
  OR EXISTS(SELECT 1 FROM document_version v WHERE v.organization_id=NEW.organization_id AND v.supersedes_id=receipt.id)
  OR basis.key<>published.key OR basis.scope_type<>published.scope_type OR basis.scope_id IS DISTINCT FROM published.scope_id
  OR basis.key<>'operations.laundry_pricing.supplier.'||native_invoice.supplier_id::text
  OR EXISTS(SELECT 1 FROM config_rule c WHERE c.organization_id=NEW.organization_id AND c.key=basis.key AND c.scope_type=basis.scope_type
   AND c.scope_id IS NOT DISTINCT FROM basis.scope_id AND c.version>basis.version AND c.version<published.version)
  OR published.version<=basis.version OR published.value->'currency' IS DISTINCT FROM basis.value->'currency'
  OR published.value->>'currency'<>association.currency OR published.value->'billing' IS DISTINCT FROM basis.value->'billing'
  OR jsonb_array_length(published.value->'prices')<>jsonb_array_length(basis.value->'prices')
 THEN RAISE EXCEPTION 'supplier_price_original_invoice_source_changed'; END IF;
 FOR changed_price IN SELECT value FROM jsonb_array_elements(published.value->'prices') LOOP
  SELECT value INTO original_price FROM jsonb_array_elements(basis.value->'prices') WHERE value->>'item'=changed_price->>'item';
  IF original_price IS NULL OR original_price->'unit' IS DISTINCT FROM changed_price->'unit' THEN RAISE EXCEPTION 'supplier_price_original_invoice_units_required';END IF;
  IF original_price->'amount' IS DISTINCT FROM changed_price->'amount' THEN
   IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(estimate.snapshot->'result'->'lines') line WHERE line->>'itemKey'=changed_price->>'item' AND line->'billable'='true'::jsonb AND(line->>'quantity')::numeric>0)
   THEN RAISE EXCEPTION 'supplier_price_original_invoice_item_required'; END IF;
   changes:=changes+1;
  END IF;
 END LOOP;
 IF changes=0 THEN RAISE EXCEPTION 'supplier_price_original_invoice_change_required'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER supplier_price_invoice_evidence_complete AFTER INSERT ON outbox_event
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_supplier_price_invoice_evidence_complete();

COMMIT;
