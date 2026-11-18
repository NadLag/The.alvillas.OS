-- Current associations share one retained expected baseline. Revisions of the
-- same supplier invoice cannot become concurrent actual costs for one batch.
CREATE FUNCTION app_actual_laundry_revision_baseline() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF NEW.operation='VOID' THEN RETURN NULL;END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('actual-laundry-invoice:'||NEW.organization_id::text||':'||NEW.invoice_id::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('laundry:'||NEW.organization_id::text||':'||NEW.batch_id::text,0));
 IF EXISTS(SELECT 1 FROM laundry_actual_invoice h WHERE h.organization_id=NEW.organization_id AND h.batch_id=NEW.batch_id AND h.id<>NEW.id AND h.operation<>'VOID' AND NOT EXISTS(SELECT 1 FROM laundry_actual_invoice n WHERE n.organization_id=h.organization_id AND n.supersedes_id=h.id) AND(h.expected_invoice_id<>NEW.expected_invoice_id OR h.invoice_id=NEW.invoice_id AND h.revision_id<>NEW.revision_id)) THEN RAISE EXCEPTION 'actual_laundry_prior_revision_baseline_requires_correction';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER actual_laundry_revision_baseline AFTER INSERT ON laundry_actual_invoice DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_actual_laundry_revision_baseline();
