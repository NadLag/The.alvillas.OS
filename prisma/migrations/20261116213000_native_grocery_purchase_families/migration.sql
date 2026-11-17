-- A correction remains associated with its original order. Retain historical
-- associations without rewriting their expense or receipt pointers.
ALTER TABLE grocery_expense_binding ADD COLUMN root_expense_id uuid;
ALTER TABLE grocery_expense_binding ADD CONSTRAINT grocery_expense_binding_root_fk FOREIGN KEY(organization_id,root_expense_id) REFERENCES expense(organization_id,id) ON DELETE RESTRICT;
ALTER TABLE grocery_expense_binding ADD CONSTRAINT grocery_expense_binding_root_key UNIQUE(organization_id,root_expense_id);
CREATE FUNCTION app_grocery_purchase_family() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE original_root uuid;
BEGIN
 SELECT p.root_expense_id INTO original_root FROM expense_purchase p WHERE p.organization_id=NEW.organization_id AND p.expense_id=NEW.expense_id;
 original_root:=COALESCE(original_root,NEW.expense_id);
 IF NEW.root_expense_id IS NOT NULL AND NEW.root_expense_id<>original_root THEN RAISE EXCEPTION 'grocery_purchase_original_family_required' USING ERRCODE='23514'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text||':grocery-purchase-family:'||original_root::text,0));
 IF EXISTS(SELECT 1 FROM grocery_expense_binding b LEFT JOIN expense_purchase p ON p.organization_id=b.organization_id AND p.expense_id=b.expense_id WHERE b.organization_id=NEW.organization_id AND COALESCE(b.root_expense_id,p.root_expense_id,b.expense_id)=original_root)
 THEN RAISE EXCEPTION 'grocery_purchase_family_already_associated' USING ERRCODE='23514'; END IF;
 NEW.root_expense_id:=original_root;RETURN NEW;
END $$;
CREATE TRIGGER grocery_purchase_family_guard BEFORE INSERT ON grocery_expense_binding FOR EACH ROW EXECUTE FUNCTION app_grocery_purchase_family();
