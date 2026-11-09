BEGIN;

-- Append native pre-conversion identity without changing any original party.
ALTER TABLE signature_recipient ADD COLUMN lead_id uuid;
ALTER TABLE signature_recipient ADD CONSTRAINT signature_recipient_org_lead_fkey
  FOREIGN KEY (organization_id,lead_id) REFERENCES lead(organization_id,id)
  ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE signature_recipient DROP CONSTRAINT signature_recipient_shape;
ALTER TABLE signature_recipient ADD CONSTRAINT signature_recipient_shape CHECK (
  num_nonnulls(person_id,owner_id,guest_id,supplier_id,lead_id)=1
  AND identity_hash ~ '^[a-f0-9]{64}$' AND octet_length(email_cipher)>0
  AND jsonb_typeof(source_snapshot)='object');
ALTER TABLE signature_recipient ADD CONSTRAINT signature_recipient_lead_reference CHECK (
  lead_id IS NULL OR coalesce((
    source_snapshot->>'protocol'='ALVILLAS_NATIVE_SIGNATURE_RECIPIENT_V1'
    AND source_snapshot#>>'{identity,organizationId}'=organization_id::text
    AND source_snapshot#>>'{identity,signatureId}'=signature_id::text
    AND source_snapshot#>>'{identity,recipientId}'=id::text
    AND source_snapshot#>>'{identity,reference,kind}'='LEAD'
    AND source_snapshot#>>'{identity,reference,id}'=lead_id::text
  ),false));

COMMIT;
