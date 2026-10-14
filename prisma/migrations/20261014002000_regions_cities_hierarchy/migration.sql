CREATE TABLE region (
  id uuid PRIMARY KEY DEFAULT app_uuid_v7(),
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  name text NOT NULL,
  code text,
  description text,
  sort_order integer NOT NULL DEFAULT 0,
  archived_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT region_name_not_blank CHECK (btrim(name) <> ''),
  CONSTRAINT region_code_uppercase_check CHECK (code IS NULL OR code = upper(code))
);

CREATE UNIQUE INDEX region_org_name_unique
  ON region (organization_id, lower(name))
  WHERE archived_at IS NULL;

CREATE INDEX region_org_archived_sort_idx
  ON region (organization_id, archived_at, sort_order, name);

CREATE TABLE city (
  id uuid PRIMARY KEY DEFAULT app_uuid_v7(),
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  region_id uuid REFERENCES region(id) ON DELETE RESTRICT,
  name text NOT NULL,
  country_code char(2) NOT NULL DEFAULT 'MA',
  timezone text NOT NULL DEFAULT 'Africa/Casablanca',
  sort_order integer NOT NULL DEFAULT 0,
  archived_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT city_name_not_blank CHECK (btrim(name) <> ''),
  CONSTRAINT city_country_uppercase_check CHECK (country_code = upper(country_code)),
  CONSTRAINT city_timezone_not_blank CHECK (btrim(timezone) <> '')
);

CREATE UNIQUE INDEX city_org_region_name_country_unique
  ON city (organization_id, region_id, lower(name), country_code)
  WHERE region_id IS NOT NULL AND archived_at IS NULL;

CREATE UNIQUE INDEX city_org_name_country_no_region_unique
  ON city (organization_id, lower(name), country_code)
  WHERE region_id IS NULL AND archived_at IS NULL;

CREATE INDEX city_org_region_archived_sort_idx
  ON city (organization_id, region_id, archived_at, sort_order, name);

CREATE INDEX city_org_archived_name_idx
  ON city (organization_id, archived_at, name);

CREATE TRIGGER region_no_delete
BEFORE DELETE ON region
FOR EACH ROW EXECUTE FUNCTION app_prevent_business_row_delete();

CREATE TRIGGER city_no_delete
BEFORE DELETE ON city
FOR EACH ROW EXECUTE FUNCTION app_prevent_business_row_delete();

ALTER TABLE region ENABLE ROW LEVEL SECURITY;
ALTER TABLE region FORCE ROW LEVEL SECURITY;
ALTER TABLE city ENABLE ROW LEVEL SECURITY;
ALTER TABLE city FORCE ROW LEVEL SECURITY;

CREATE POLICY region_tenant_isolation ON region
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

CREATE POLICY city_tenant_isolation ON city
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

INSERT INTO region (organization_id, name, created_by)
SELECT property.organization_id, btrim(property.region), min(property.created_by::text)::uuid
FROM property
WHERE property.region IS NOT NULL
  AND btrim(property.region) <> ''
GROUP BY property.organization_id, btrim(property.region)
ON CONFLICT DO NOTHING;

INSERT INTO city (organization_id, region_id, name, country_code, timezone, created_by)
SELECT
  property.organization_id,
  region.id,
  btrim(property.city),
  upper(min(property.country_code))::char(2),
  min(property.timezone),
  min(property.created_by::text)::uuid
FROM property
LEFT JOIN region
  ON region.organization_id = property.organization_id
 AND lower(region.name) = lower(btrim(property.region))
 AND region.archived_at IS NULL
WHERE btrim(property.city) <> ''
GROUP BY property.organization_id, region.id, btrim(property.city)
ON CONFLICT DO NOTHING;

ALTER TABLE property
  ADD COLUMN region_id uuid,
  ADD COLUMN city_id uuid;

UPDATE property
SET
  region_id = city.region_id,
  city_id = city.id
FROM city
WHERE city.organization_id = property.organization_id
  AND lower(city.name) = lower(btrim(property.city))
  AND city.country_code = property.country_code
  AND (
    (city.region_id IS NULL AND (property.region IS NULL OR btrim(property.region) = ''))
    OR city.region_id = (
      SELECT region.id
      FROM region
      WHERE region.organization_id = property.organization_id
        AND lower(region.name) = lower(btrim(property.region))
        AND region.archived_at IS NULL
      LIMIT 1
    )
  );

ALTER TABLE property
  ADD CONSTRAINT property_region_id_fkey FOREIGN KEY (region_id) REFERENCES region(id) ON DELETE RESTRICT,
  ADD CONSTRAINT property_city_id_fkey FOREIGN KEY (city_id) REFERENCES city(id) ON DELETE RESTRICT;

CREATE INDEX property_org_region_name_idx
  ON property (organization_id, region_id, name);

CREATE INDEX property_org_city_id_name_idx
  ON property (organization_id, city_id, name);

CREATE OR REPLACE FUNCTION app_property_resolve_geography()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  normalized_region text;
  normalized_city text;
  resolved_region_id uuid;
  resolved_region_name text;
  resolved_city_id uuid;
BEGIN
  IF NEW.city_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  normalized_city := NULLIF(btrim(NEW.city), '');

  IF normalized_city IS NULL THEN
    RAISE EXCEPTION 'property city is required';
  END IF;

  NEW.city := normalized_city;
  NEW.country_code := upper(coalesce(NULLIF(btrim(NEW.country_code), ''), 'MA'))::char(2);
  NEW.timezone := coalesce(NULLIF(btrim(NEW.timezone), ''), 'Africa/Casablanca');

  IF NEW.region_id IS NOT NULL THEN
    SELECT region.id, region.name
      INTO resolved_region_id, resolved_region_name
      FROM region
     WHERE region.id = NEW.region_id
       AND region.organization_id = NEW.organization_id
       AND region.archived_at IS NULL;

    IF resolved_region_id IS NULL THEN
      RAISE EXCEPTION 'property region must belong to the same active organization';
    END IF;
  ELSE
    normalized_region := NULLIF(btrim(NEW.region), '');

    IF normalized_region IS NOT NULL THEN
      SELECT region.id, region.name
        INTO resolved_region_id, resolved_region_name
        FROM region
       WHERE region.organization_id = NEW.organization_id
         AND lower(region.name) = lower(normalized_region)
         AND region.archived_at IS NULL
       LIMIT 1;

      IF resolved_region_id IS NULL THEN
        INSERT INTO region (organization_id, name, created_by)
        VALUES (NEW.organization_id, normalized_region, NEW.created_by)
        ON CONFLICT DO NOTHING
        RETURNING id, name INTO resolved_region_id, resolved_region_name;

        IF resolved_region_id IS NULL THEN
          SELECT region.id, region.name
            INTO resolved_region_id, resolved_region_name
            FROM region
           WHERE region.organization_id = NEW.organization_id
             AND lower(region.name) = lower(normalized_region)
             AND region.archived_at IS NULL
           LIMIT 1;
        END IF;
      END IF;
    END IF;
  END IF;

  SELECT city.id
    INTO resolved_city_id
    FROM city
   WHERE city.organization_id = NEW.organization_id
     AND lower(city.name) = lower(normalized_city)
     AND city.country_code = NEW.country_code
     AND city.archived_at IS NULL
     AND (
       (city.region_id IS NULL AND resolved_region_id IS NULL)
       OR city.region_id = resolved_region_id
     )
   LIMIT 1;

  IF resolved_city_id IS NULL THEN
    INSERT INTO city (organization_id, region_id, name, country_code, timezone, created_by)
    VALUES (NEW.organization_id, resolved_region_id, normalized_city, NEW.country_code, NEW.timezone, NEW.created_by)
    ON CONFLICT DO NOTHING
    RETURNING id INTO resolved_city_id;

    IF resolved_city_id IS NULL THEN
      SELECT city.id
        INTO resolved_city_id
        FROM city
       WHERE city.organization_id = NEW.organization_id
         AND lower(city.name) = lower(normalized_city)
         AND city.country_code = NEW.country_code
         AND city.archived_at IS NULL
         AND (
           (city.region_id IS NULL AND resolved_region_id IS NULL)
           OR city.region_id = resolved_region_id
         )
       LIMIT 1;
    END IF;
  END IF;

  NEW.region_id := resolved_region_id;
  NEW.region := resolved_region_name;
  NEW.city_id := resolved_city_id;

  RETURN NEW;
END;
$$;

CREATE TRIGGER property_geography_resolve
BEFORE INSERT OR UPDATE OF organization_id, region_id, city_id, city, region, country_code ON property
FOR EACH ROW EXECUTE FUNCTION app_property_resolve_geography();

CREATE OR REPLACE FUNCTION app_property_geography_tenant_check()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  city_region_id uuid;
BEGIN
  SELECT city.region_id
    INTO city_region_id
    FROM city
   WHERE city.id = NEW.city_id
     AND city.organization_id = NEW.organization_id
     AND city.archived_at IS NULL;

  IF city_region_id IS NULL AND NOT EXISTS (
    SELECT 1
      FROM city
     WHERE city.id = NEW.city_id
       AND city.organization_id = NEW.organization_id
       AND city.archived_at IS NULL
       AND city.region_id IS NULL
  ) THEN
    RAISE EXCEPTION 'property city must belong to the same active organization';
  END IF;

  IF NEW.region_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1
        FROM region
       WHERE region.id = NEW.region_id
         AND region.organization_id = NEW.organization_id
         AND region.archived_at IS NULL
    ) THEN
      RAISE EXCEPTION 'property region must belong to the same active organization';
    END IF;

    IF city_region_id IS DISTINCT FROM NEW.region_id THEN
      RAISE EXCEPTION 'property region must match city region';
    END IF;
  ELSIF city_region_id IS NOT NULL THEN
    RAISE EXCEPTION 'property region is required for the selected city';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER property_geography_tenant_check
BEFORE INSERT OR UPDATE OF organization_id, region_id, city_id ON property
FOR EACH ROW EXECUTE FUNCTION app_property_geography_tenant_check();

INSERT INTO permission (organization_id, key, resource, action, description)
SELECT organization.id, resource || ':' || action, resource, action, action || ' ' || resource
FROM organization
CROSS JOIN (VALUES ('region'), ('city')) AS resources(resource)
CROSS JOIN (VALUES ('view'), ('create'), ('edit'), ('configure')) AS actions(action)
ON CONFLICT (organization_id, key) DO UPDATE
SET resource = EXCLUDED.resource,
    action = EXCLUDED.action,
    description = EXCLUDED.description;

INSERT INTO role_permission (organization_id, role_id, permission_id)
SELECT role.organization_id, role.id, permission.id
FROM role
JOIN permission
  ON permission.organization_id = role.organization_id
 AND permission.key IN (
   'region:view',
   'region:create',
   'region:edit',
   'region:configure',
   'city:view',
   'city:create',
   'city:edit',
   'city:configure'
 )
WHERE role.key = 'admin'
  AND role.archived_at IS NULL
ON CONFLICT (organization_id, role_id, permission_id) DO NOTHING;

INSERT INTO role_permission (organization_id, role_id, permission_id)
SELECT role.organization_id, role.id, permission.id
FROM role
JOIN permission
  ON permission.organization_id = role.organization_id
 AND permission.key IN ('region:view', 'city:view')
WHERE role.key IN ('operations_manager', 'regional_manager')
  AND role.archived_at IS NULL
ON CONFLICT (organization_id, role_id, permission_id) DO NOTHING;
