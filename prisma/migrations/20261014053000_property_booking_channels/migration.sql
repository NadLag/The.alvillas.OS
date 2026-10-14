CREATE TABLE booking_channel (
  id uuid PRIMARY KEY DEFAULT app_uuid_v7(),
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  property_id uuid NOT NULL REFERENCES property(id) ON DELETE RESTRICT,
  source_key text NOT NULL,
  display_name text NOT NULL,
  external_listing_id text,
  listing_url text,
  sync_mode text NOT NULL DEFAULT 'MANUAL',
  import_enabled boolean NOT NULL DEFAULT false,
  export_enabled boolean NOT NULL DEFAULT false,
  sync_endpoint_encrypted text,
  masked_sync_endpoint text,
  status text NOT NULL DEFAULT 'ACTIVE',
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_sync_at timestamptz,
  last_sync_status text,
  last_sync_message text,
  archived_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT booking_channel_source_key_check CHECK (source_key ~ '^[A-Z0-9_]{2,40}$'),
  CONSTRAINT booking_channel_display_name_check CHECK (length(trim(display_name)) > 0),
  CONSTRAINT booking_channel_status_check CHECK (status IN ('ACTIVE', 'PAUSED', 'DISCONNECTED')),
  CONSTRAINT booking_channel_sync_mode_check CHECK (sync_mode IN ('MANUAL', 'ICAL', 'API', 'CSV', 'CHANNEL_MANAGER')),
  CONSTRAINT booking_channel_listing_url_check CHECK (listing_url IS NULL OR listing_url ~ '^https?://'),
  CONSTRAINT booking_channel_endpoint_pair_check CHECK (
    (sync_endpoint_encrypted IS NULL AND masked_sync_endpoint IS NULL) OR
    (sync_endpoint_encrypted IS NOT NULL AND masked_sync_endpoint IS NOT NULL AND length(sync_endpoint_encrypted) > 20)
  ),
  CONSTRAINT booking_channel_settings_object_check CHECK (jsonb_typeof(settings) = 'object'),
  CONSTRAINT booking_channel_org_property_source_unique UNIQUE (organization_id, property_id, source_key)
);

CREATE INDEX booking_channel_org_property_archived_idx
  ON booking_channel (organization_id, property_id, archived_at, source_key);

CREATE INDEX booking_channel_org_status_sync_idx
  ON booking_channel (organization_id, status, sync_mode);

CREATE OR REPLACE FUNCTION app_assert_booking_channel_organization_consistency()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  property_org uuid;
BEGIN
  SELECT organization_id INTO property_org
  FROM property
  WHERE id = NEW.property_id;

  IF property_org IS DISTINCT FROM NEW.organization_id THEN
    RAISE EXCEPTION 'booking channel organization mismatch';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER booking_channel_organization_consistency
BEFORE INSERT OR UPDATE ON booking_channel
FOR EACH ROW EXECUTE FUNCTION app_assert_booking_channel_organization_consistency();

CREATE TRIGGER booking_channel_no_delete
BEFORE DELETE ON booking_channel
FOR EACH ROW EXECUTE FUNCTION app_prevent_business_row_delete();

ALTER TABLE booking_channel ENABLE ROW LEVEL SECURITY;
ALTER TABLE booking_channel FORCE ROW LEVEL SECURITY;

CREATE POLICY booking_channel_tenant_isolation ON booking_channel
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
