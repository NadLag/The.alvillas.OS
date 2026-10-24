# ADR 0058: Offline dependencies load with the Field shell

Date: 2026-10-23

Status: Accepted

A first staging visit cached the anonymous shell and saved its draft correctly, but a cold offline reload could not restore it. The browser requested a generated Turbopack namespace chunk for a dynamic import of the queue. That chunk had loaded before the service worker controlled the first page and was absent from the shell's static dependency list. Previously installed/warm browser journeys did not expose this case.

Queue access, scope validation, live queries, pull and synchronization now use eager module imports on their client paths. Logout also imports the wipe helper eagerly so a missing lazy namespace cannot skip local cleanup. The shell's existing referenced-asset preparation includes these dependencies. IndexedDB instantiation and network effects remain inside their established lifecycle/callbacks. The bundle tradeoff is intentional: an offline action cannot depend on downloading its implementation.

The regression delays first-visit service-worker registration until a real assigned draft is persisted, then installs the native worker and reloads offline in a fresh browser context. It asserts the exact note/checklist, cache readiness, no storage warning and an untouched operation queue. It fails on both desktop and mobile before this change. Authenticated staging acceptance remains required before closing the affected Field features.
