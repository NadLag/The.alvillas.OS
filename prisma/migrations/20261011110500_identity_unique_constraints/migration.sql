DROP INDEX person_org_email_unique;
DROP INDEX user_account_org_email_unique;

ALTER TABLE person
  ADD CONSTRAINT person_org_email_unique UNIQUE (organization_id, email);

ALTER TABLE user_account
  ADD CONSTRAINT user_account_org_email_unique UNIQUE (organization_id, email);
