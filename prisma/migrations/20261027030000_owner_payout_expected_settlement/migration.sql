BEGIN;

-- An attributed expected instant is distinct from the eventual bank receipt.
-- Adding a nullable column preserves every existing business tuple and amount.
ALTER TABLE owner_payout ADD COLUMN expected_settlement_at timestamptz(6);

CREATE FUNCTION app_owner_payout_settlement_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' AND OLD.state<>'DRAFT' AND NEW.expected_settlement_at IS DISTINCT FROM OLD.expected_settlement_at
 THEN RAISE EXCEPTION 'submitted payout expected settlement is immutable'; END IF;
 IF TG_OP='UPDATE' AND OLD.state='DRAFT' AND NEW.state<>'DRAFT' AND NEW.expected_settlement_at IS DISTINCT FROM OLD.expected_settlement_at
 THEN RAISE EXCEPTION 'expected settlement changes require a separate audited draft revision'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER owner_payout_settlement_guard BEFORE UPDATE ON owner_payout
 FOR EACH ROW EXECUTE FUNCTION app_owner_payout_settlement_guard();

CREATE FUNCTION app_owner_payout_settlement_audit_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' OR NEW.expected_settlement_at IS DISTINCT FROM OLD.expected_settlement_at THEN
  IF NOT EXISTS(SELECT 1 FROM audit_log l WHERE l.organization_id=NEW.organization_id AND l.resource_type='owner_payout' AND l.resource_id=NEW.id
   AND l.action=CASE WHEN TG_OP='INSERT' THEN 'finance.owner_payout.created' ELSE 'finance.owner_payout.edited' END
   AND l.actor_id=NEW.updated_by AND (l.after->>'version')::integer=NEW.version
   AND (l.after->'request'->>'expectedSettlementAt')::timestamptz IS NOT DISTINCT FROM NEW.expected_settlement_at)
  THEN RAISE EXCEPTION 'owner payout expected settlement requires its attributed source audit'; END IF;
 END IF;
 IF NEW.policy_snapshot IS NOT NULL AND (NEW.policy_snapshot->>'expectedSettlementAt')::timestamptz IS DISTINCT FROM NEW.expected_settlement_at
 THEN RAISE EXCEPTION 'owner payout must freeze its expected settlement evidence'; END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER owner_payout_settlement_audit_guard AFTER INSERT OR UPDATE ON owner_payout
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_owner_payout_settlement_audit_guard();

COMMIT;
