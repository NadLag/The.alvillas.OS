BEGIN;
-- Retain the existing admissible kinds and admit the source-bound employee notice envelope.
DO $$
DECLARE previous_check text;
BEGIN
 SELECT pg_get_expr(conbin,conrelid) INTO STRICT previous_check FROM pg_constraint
  WHERE conrelid='notification'::regclass AND conname='notification_kind_check';
 EXECUTE format('ALTER TABLE notification ADD CONSTRAINT notification_kind_with_employee_cost_notice CHECK ((%s) OR kind=%L)',previous_check,'employee_cost_emergency');
 ALTER TABLE notification DROP CONSTRAINT notification_kind_check;
 ALTER TABLE notification RENAME CONSTRAINT notification_kind_with_employee_cost_notice TO notification_kind_check;
END $$;
COMMIT;
