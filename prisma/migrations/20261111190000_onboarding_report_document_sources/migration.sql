BEGIN;
-- AlterTable
ALTER TABLE "document" ADD COLUMN     "onboarding_revision_id" UUID;

-- CreateIndex
CREATE INDEX "document_org_onboarding_review_idx" ON "document"("organization_id", "onboarding_revision_id", "id");

-- AddForeignKey
ALTER TABLE "document" ADD CONSTRAINT "document_onboarding_review_fk" FOREIGN KEY ("organization_id", "onboarding_revision_id") REFERENCES "property_onboarding_revision"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;


ALTER TABLE document DROP CONSTRAINT document_source_shape;
ALTER TABLE document ADD CONSTRAINT document_source_shape CHECK (coalesce((
 (source_kind='ORGANIZATION' AND source_id=organization_id AND num_nonnulls(property_id,owner_id,reservation_id,person_id,transaction_id,supplier_id,guest_id,lead_id,onboarding_revision_id)=0)
 OR (num_nonnulls(property_id,owner_id,reservation_id,person_id,transaction_id,supplier_id,guest_id,lead_id,onboarding_revision_id)=1 AND
  ((source_kind='PROPERTY' AND property_id=source_id) OR (source_kind='OWNER' AND owner_id=source_id)
   OR (source_kind='RESERVATION' AND reservation_id=source_id) OR (source_kind='PERSON' AND person_id=source_id)
   OR (source_kind='FINANCIAL_TRANSACTION' AND transaction_id=source_id) OR (source_kind='SUPPLIER' AND supplier_id=source_id)
   OR (source_kind='GUEST' AND guest_id=source_id) OR (source_kind='LEAD' AND lead_id=source_id)
   OR (source_kind='ONBOARDING' AND onboarding_revision_id=source_id)))),false));
ALTER TABLE document ADD CONSTRAINT document_onboarding_source_privacy CHECK(source_kind<>'ONBOARDING' OR privacy@>ARRAY['sensitive','financial']);

CREATE FUNCTION app_guard_onboarding_document_source() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF NEW.source_kind='ONBOARDING' AND NOT EXISTS(
  SELECT 1 FROM property_onboarding_revision r JOIN owner o ON o.organization_id=r.organization_id AND o.id=r.owner_id
  JOIN property p ON p.organization_id=r.organization_id AND p.id=r.property_id
  WHERE r.organization_id=NEW.organization_id AND r.id=NEW.onboarding_revision_id AND r.step='REVIEW' AND r.mode='VALIDATE'
   AND o.archived_at IS NULL AND p.archived_at IS NULL
 ) THEN RAISE EXCEPTION 'onboarding document source requires its actual tenant-bound native Review'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER onboarding_document_source_guard BEFORE INSERT ON document FOR EACH ROW EXECUTE FUNCTION app_guard_onboarding_document_source();

COMMIT;
