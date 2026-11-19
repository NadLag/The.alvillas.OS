# Load rehearsal

F-PRF-01 exercises the property directory, company reports and bursts of authenticated field sync pulls for the 10, 100 and 500 property profiles. Use a dedicated fixture database with five years of representative history and a matching application revision. Measure only on a loopback target or owner-approved ALVILLAS staging.

Set the fixture revision, tenant and calendar date through `ALVILLAS_LOAD_EXPECTED_SHA`, `ALVILLAS_LOAD_ORGANIZATION_ID` and `ALVILLAS_LOAD_THROUGH_ON`. Set `ALVILLAS_LOAD_PROFILE` to the property count and `ALVILLAS_LOAD_DB_URL` to the loopback fixture database. Generate the manifest with `node --import tsx scripts/load/verify-dataset.ts` and retain its JSON output outside Git.

Set `ALVILLAS_LOAD_DATASET_FILE` and `ALVILLAS_LOAD_TARGET`. Supply privately acquired fixture session cookies through `ALVILLAS_LOAD_ADMIN_COOKIE` and `ALVILLAS_LOAD_FIELD_COOKIE` and the actual field actor through `ALVILLAS_LOAD_FIELD_ACCOUNT_ID`. For protected staging, use the approved automation credential and `ALVILLAS_LOAD_APPROVAL_REFERENCE`. Execute `k6 run scripts/load/approved-profiles.js`. Preserve the profile and application SHA with the results. Retain lifecycle, SSR and database measurements separately so a harness-only result cannot be accepted as a full load pass.
