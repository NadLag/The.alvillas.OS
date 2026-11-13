# Durable native activation continuations

The shared outbox forwards identifier-only job references to the signed Inngest endpoint. A native consumer advances one actual canonical effect, or completes the actual native activation after the five proofs exist. It retains the existing current/captured authorization, original intent, retry policy, document workers, email worker and completion transactions.

A separate execution advisory lock serializes native job control without holding the canonical phase lock. Canonical effects retain their independent commit boundaries. The control transaction schedules one immutable successor per consumed outbox source. Replaying an already continued source never consumes another attempt. Waiting uses the captured backoff and actual retry/reset time through the existing outbox due index; it does not record a business failure or claim completion.

The existing recovery timer scans all pages of current nonterminal dispatched leaves. It schedules a missing successor after a crash or exhausted infrastructure run, preserving already committed canonical effects and original nonces. Pending future sources, blocked/failed/completed runs, superseded intents and failed transport sources are not silently reactivated.

Additive migration243 validates the actual original run, parent source, current native head, policy due time, immutable payload and atomic original-principal audit. No new business table, financial operation, provider send or parallel workflow state is introduced. The execution control transaction and a canonical producer use separate database connections. Its transaction bound remains below the existing300-second endpoint bound. Provider/staging restrictions and all355 feature requirements remain unchanged.
