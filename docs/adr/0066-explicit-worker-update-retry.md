# 0066 — Retry explicit worker activation without accepting an older controller

PR #95 CI run 40091442253 passed 149 browser journeys and failed the Arabic mobile explicit update journey. Its diagnostic retained an installed waiting worker, the old activated controller, an unchanged document, an unavailable notice and no pending network requests. The diagnostic does not establish whether the initial message was delivered or whether another registration replaced the waiting slot.

An explicit refresh now resends the idempotent skip-waiting request every 250 ms while the selected worker remains installed, within the existing three-second deadline. Retransmission does not reuse a transferred MessagePort. If another waiting worker replaces it, the helper follows that worker. Reload still requires the selected replacement to be activated and to control the current document; acknowledgement, an empty waiting slot and the old controller remain insufficient. Failure preserves the current document and durable queue.

Two deterministic regressions fail before the correction: an undelivered first request and replacement of the waiting slot. All existing activation, controller-adoption, missed-event, stalled-worker and retained-work assertions remain. Native browser update journeys verify the actual lifecycle independently of these controlled delivery cases.
