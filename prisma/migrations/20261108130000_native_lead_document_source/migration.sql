-- Forward-only native acquisition source. Historical documents receive no
-- backfill or default, and their original sources and tuple versions remain.
ALTER TABLE document ADD COLUMN lead_id uuid;
ALTER TABLE document ADD CONSTRAINT document_lead_tenant_fk
  FOREIGN KEY (organization_id,lead_id) REFERENCES lead(organization_id,id)
  ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE document DROP CONSTRAINT document_source_shape;
ALTER TABLE document ADD CONSTRAINT document_source_shape CHECK (coalesce((
  (source_kind='ORGANIZATION' AND source_id=organization_id
    AND num_nonnulls(property_id,owner_id,reservation_id,person_id,transaction_id,supplier_id,guest_id,lead_id)=0)
  OR (num_nonnulls(property_id,owner_id,reservation_id,person_id,transaction_id,supplier_id,guest_id,lead_id)=1 AND
    ((source_kind='PROPERTY' AND property_id=source_id) OR (source_kind='OWNER' AND owner_id=source_id)
     OR (source_kind='RESERVATION' AND reservation_id=source_id) OR (source_kind='PERSON' AND person_id=source_id)
     OR (source_kind='FINANCIAL_TRANSACTION' AND transaction_id=source_id)
     OR (source_kind='SUPPLIER' AND supplier_id=source_id) OR (source_kind='GUEST' AND guest_id=source_id)
     OR (source_kind='LEAD' AND lead_id=source_id)))),false));
ALTER TABLE document ADD CONSTRAINT document_lead_source_privacy CHECK (
  source_kind<>'LEAD' OR privacy@>ARRAY['sensitive']);
