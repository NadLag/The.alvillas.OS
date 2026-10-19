# STUBS.md - ALVILLAS OS

This file lists stubs, fakes, placeholders, or fake-provider paths that appear outside tests. Features remain `IN-PROGRESS` until the real implementation replaces them.

| Location | Kind | Status |
|---|---|---|
| src/platform/providers/fakes.ts | Dev/test fake providers for email, signature, payment, storage, reservations, notifications, PDF, and rate limiting | Guarded against production use. Replace with real provider wiring and admin "not configured" indicators before F-FND-10 can be `DONE`. |
