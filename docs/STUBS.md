# STUBS.md - ALVILLAS OS

This file lists stubs, fakes, placeholders, or fake-provider paths that appear outside tests. Features remain `IN-PROGRESS` until the real implementation replaces them.

| Location | Kind | Status |
|---|---|---|
| src/platform/providers/fakes.ts | Dev/test fake providers for email, signature, payment, storage, reservations, notifications, PDF, and rate limiting | Guarded against production use. Replace with real provider wiring and admin "not configured" indicators before F-FND-10 can be `DONE`. |
| src/modules/finance/application/native-paypal-admission.ts | Optional external-payment fee posting and private workflow integration remain in progress | Original capture time and exact gross/deduction/net evidence are retained. Admission rejects missing settlement or an unposted deduction; native fee posting, private UI and complete financial acceptance remain required. Actual-source audit presentation and private nonce-recovery APIs are implemented and covered by affected acceptance. F-FIN-08/F-FIN-09 stay `IN-PROGRESS`. |
