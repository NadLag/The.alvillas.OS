-- Preserve existing completion data and permit staff profiles without logins.
-- Their checklist completion must belong to an audited, distinct proxy validator.
ALTER TABLE operation_task_checklist_item
  DROP CONSTRAINT operation_task_check_completed_pair_check,
  ADD CONSTRAINT operation_task_check_completed_pair_check CHECK (
    (completed_at IS NULL AND completed_by_user_account_id IS NULL AND completed_by_person_id IS NULL)
    OR (completed_at IS NOT NULL AND completed_by_person_id IS NOT NULL)
  );

CREATE FUNCTION app_operation_person_proxy_checklist() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE target_task_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'operation_task' THEN
    target_task_id := NEW.id;
  ELSE
    target_task_id := NEW.task_id;
  END IF;
  IF EXISTS (
    SELECT 1 FROM operation_task_checklist_item item
    JOIN operation_task task ON task.organization_id = item.organization_id AND task.id = item.task_id
    WHERE item.organization_id = NEW.organization_id AND item.task_id = target_task_id
      AND item.completed_at IS NOT NULL AND item.completed_by_user_account_id IS NULL
      AND NOT (
        COALESCE(task.completion_source, '') = 'PROXY' AND task.state = 'COMPLETED'
        AND task.completed_at IS NOT NULL
        AND task.assigned_to_person_id IS NOT NULL AND task.assigned_to_person_id = item.completed_by_person_id
        AND task.completed_by_person_id IS NOT NULL AND task.completed_by_person_id = item.completed_by_person_id
        AND task.assigned_to_user_account_id IS NULL AND task.completed_by_user_account_id IS NULL
        AND task.validated_by_person_id IS NOT NULL AND task.validated_by_person_id <> item.completed_by_person_id
        AND task.validated_by_user_account_id IS NOT NULL AND task.validated_at IS NOT NULL
        AND length(COALESCE(task.validation_reason, '')) >= 6
      )
  ) THEN
    RAISE EXCEPTION 'Person-only checklist completion requires audited proxy validation' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER operation_item_person_proxy_validation
  AFTER INSERT OR UPDATE ON operation_task_checklist_item
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_operation_person_proxy_checklist();
CREATE CONSTRAINT TRIGGER operation_task_person_proxy_validation
  AFTER INSERT OR UPDATE ON operation_task
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_operation_person_proxy_checklist();
