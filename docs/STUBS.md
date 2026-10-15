# STUBS.md - ALVILLAS OS

This file lists stubs, fakes, placeholders, or fake-provider paths that appear outside tests. Features remain `IN-PROGRESS` until the real implementation replaces them.

| Location | Kind | Status |
|---|---|---|
| docs/archive/PHASE_1_MASTER_USER_FLOW_SYSTEM_MAP.md | Documentation placeholder for a future financial snapshot in the reservation flow | No application code exists yet; related handbook features remain `TODO` in `PROGRESS.md`. |
| src/platform/providers/fakes.ts | Dev/test fake providers for email, signature, payment, storage, reservations, notifications, PDF, and rate limiting | Guarded against production use. Replace with real provider wiring and admin "not configured" indicators before F-FND-10 can be `DONE`. |
| src/platform/notifications/notification-channel-service.ts | Push routing has an interface and durable jobs; the production push adapter and subscription lifecycle are absent | F-NTF-04/F-NTF-05 remain `IN-PROGRESS`. Missing providers fail explicitly; no fake acknowledgement. Real email and push acceptance remains required. |
