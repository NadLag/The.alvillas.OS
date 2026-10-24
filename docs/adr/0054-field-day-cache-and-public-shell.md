# ADR 0054: Field day cache and anonymous offline shell

Date: 2026-10-23

Status: Accepted

The field application needs to reopen saved work without a network connection. Authenticated HTML and API responses must not become shared worker cache entries.

The shared worker prepares an anonymous shell at each EN/FR/AR `/offline/field` route. The shell renders public messages before loading device data. Installation stores each shell only after downloading its referenced static assets. Failed field navigations redirect to the shell's actual URL, keeping the Next.js document and route consistent. CacheStorage contains only these anonymous documents and public static assets. Assigned operational records remain in the existing account-scoped Dexie database.

The additive version-two database adds job snapshots, drafts and cache state while retaining original operation keys, device identity and conflict evidence. Pull pages and known-record checks are validated and staged before one atomic cache transaction. A cache generation rejects a late pull after completion. A separate activation nonce rejects old pulls and draft saves after logout and sign-in by the same account. Completion acknowledgement removes the matching job and draft in the same transaction as the operation acknowledgement.

Today uses each record's server-supplied property business date; My jobs includes all current assignments. Both views paginate locally. Checklist drafts save on the device without pretending to be completed server work. The offline shell reuses the existing form and completion queue. Locale changes preserve the same form and queued operation; server authorization remains required when operations arrive.

Before showing cached data online, the application checks the current session. Offline access uses the last verified local owner. Conditional activation and wipes prevent an old response from erasing another account's work. Logout and confirmed revocation remove device data. Quota failures retain the prior complete snapshot and queued operations; the user can retry after freeing storage. Public shell pages remain anonymous after a wipe.

This increment does not complete the other native field operation types, critical conflict resolution, photo uploads or the remaining device-hygiene requirements. Those features stay IN-PROGRESS until implemented and accepted.
