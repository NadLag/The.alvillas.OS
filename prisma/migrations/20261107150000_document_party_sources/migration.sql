-- Forward-only extension: previous documents, financial history and policy
-- snapshots are retained. Nullable columns have no default and no data backfill.
ALTER TABLE document ADD COLUMN supplier_id uuid, ADD COLUMN guest_id uuid;
ALTER TABLE document ADD CONSTRAINT document_supplier_tenant_fk
  FOREIGN KEY (organization_id,supplier_id) REFERENCES supplier(organization_id,id) ON UPDATE NO ACTION ON DELETE RESTRICT;
ALTER TABLE document ADD CONSTRAINT document_guest_tenant_fk
  FOREIGN KEY (organization_id,guest_id) REFERENCES guest(organization_id,id) ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE document DROP CONSTRAINT document_source_shape;
ALTER TABLE document ADD CONSTRAINT document_source_shape CHECK (coalesce((
  (source_kind='ORGANIZATION' AND source_id=organization_id AND num_nonnulls(property_id,owner_id,reservation_id,person_id,transaction_id,supplier_id,guest_id)=0)
  OR (num_nonnulls(property_id,owner_id,reservation_id,person_id,transaction_id,supplier_id,guest_id)=1 AND
    ((source_kind='PROPERTY' AND property_id=source_id) OR (source_kind='OWNER' AND owner_id=source_id)
     OR (source_kind='RESERVATION' AND reservation_id=source_id) OR (source_kind='PERSON' AND person_id=source_id)
     OR (source_kind='FINANCIAL_TRANSACTION' AND transaction_id=source_id)
     OR (source_kind='SUPPLIER' AND supplier_id=source_id) OR (source_kind='GUEST' AND guest_id=source_id)))),false));
ALTER TABLE document ADD CONSTRAINT document_private_party_source CHECK (
  source_kind NOT IN ('SUPPLIER','GUEST') OR privacy@>ARRAY['sensitive']);

-- Categories are explicit captured configuration, never inferred from file names,
-- translations or type keys. Unclassified historical policies remain unchanged.
CREATE FUNCTION app_document_category_protected(snapshot jsonb,type_key text,protection text[])
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
  SELECT coalesce(bool_and(
    NOT (item ? 'category') OR coalesce(
      item->>'category' IN ('OWNER_CONTRACT','AMENDMENT','GUEST_AGREEMENT','HOUSE_RULES','INVOICE','RECEIPT','PROPERTY','SUPPLIER','STAFF','REPORT')
      AND (item->>'category' NOT IN ('INVOICE','RECEIPT') OR protection@>ARRAY['financial'])
      AND (item->>'category' NOT IN ('OWNER_CONTRACT','GUEST_AGREEMENT','SUPPLIER','STAFF') OR protection@>ARRAY['sensitive']),false)),true)
  FROM jsonb_array_elements(CASE WHEN jsonb_typeof(snapshot->'value'->'types')='array' THEN snapshot->'value'->'types' ELSE '[]'::jsonb END) item
  WHERE item->>'key'=type_key
$$;
ALTER TABLE document ADD CONSTRAINT document_captured_category_protection
  CHECK (app_document_category_protected(policy_snapshot,type_key,privacy));
