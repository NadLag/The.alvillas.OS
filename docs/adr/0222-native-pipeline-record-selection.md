# ADR 0222 — Native pipeline record selection

The pipeline writer validates native proposal, contract, provider, signed archive and Owner-conversion evidence. The stage editor previously disabled every transition requiring that evidence, leaving the native acquisition flow dependent on API commands.

The editor now selects records through the existing platform document bridge. Its strict read protocol binds the Lead, current revision, approved destination and ordered proof prefix. Document choices use the canonical source catalog and effective history; signature choices use the canonical signature catalog and history. Provider events, completed archives and conversions retain their existing tenant-bound repositories and native proof validation. Canonical document errors are normalized at the CRM read boundary.

Catalog reads authorize the current Lead and destination, validate the selected prefix, append an identifier-based audit and check the stage, assignment and policy again. Canonical readers retain their independent source, privacy, held/current authority and publication checks. Selection returns authorized record metadata. The existing review fingerprint, actor-bound nonce, admission, recovery, append-only history, audit and outbox remain the stage-writing protocol.

The client keeps choices in the private workspace lifecycle. Changing a selection clears its dependent choices; offline, visibility and scope changes clear the workspace. EN, FR and AR messages describe the actual records. Owner conversion uses the canonical Core lifecycle from ADR 0220. Go Live continues to require the native onboarding release producer in F-ONB-07.

PROGRESS.md records verification and remaining acceptance. Existing financial history, authorization assertions and the zero-retry browser policy remain release requirements.
