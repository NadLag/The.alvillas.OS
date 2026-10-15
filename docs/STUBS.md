# STUBS.md - ALVILLAS OS

This file lists stubs, fakes, placeholders, or fake-provider paths that appear outside tests. Features remain `IN-PROGRESS` until the real implementation replaces them.

| Location | Kind | Status |
|---|---|---|
| docs/archive/PHASE_1_MASTER_USER_FLOW_SYSTEM_MAP.md | Documentation placeholder for a future financial snapshot in the reservation flow | No application code exists yet; related handbook features remain `TODO` in `PROGRESS.md`. |
| src/platform/providers/fakes.ts | Dev/test fake providers for email, signature, payment, storage, reservations, notifications, PDF, and rate limiting | Guarded against production use. Replace with real provider wiring and admin "not configured" indicators before F-FND-10 can be `DONE`. |
| src/platform/notifications/push-delivery-service.ts | Production adapter, encrypted subscriptions, durable device delivery and browser lifecycle are implemented; real-provider acceptance remains blocked | F-NTF-04/F-NTF-05 remain `IN-PROGRESS` until Inngest job credentials/scheduling and authenticated external push acceptance are verified. VAPID is configured privately on preview; local vendor transport/CDP tests do not count as live provider delivery. |
