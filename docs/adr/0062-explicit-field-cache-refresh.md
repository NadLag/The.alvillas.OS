# ADR 0062: Explicit refresh after active cache reads

Date: 2026-10-24

Status: Accepted

Background cache reads continue to share the active tenant/account request. An explicit Sync, focus or restored-connection request must also observe changes made after an older request began. Joining that older response can leave current work stale and skip a newly relevant storage failure. Explicit requests now wait for the active read and start one fresh read; concurrent follow-up calls still share that new read. Failure of the older request does not consume the explicit retry.

The existing cursor, generation, incarnation, atomic publication, authorization and owner-change guards remain authoritative. The PWA passes the explicit intent to the shared pull helper; it does not duplicate cache or sync logic. Two deterministic regression cases failed before the change and pass afterward, covering later changes and recovery after an older failure. The full browser journey retains its persistent quota fault, previous snapshot, retry and single-completion assertions.

The manual Sync control remains available after automatic recovery. Removing it as a background request succeeds can detach a focused or touched button before activation. Offline and active-request guards still disable it. The browser regression restores quota, completes a focus-triggered recovery, then activates the same manual control and requires a new successful native pull. Both desktop and mobile failed before this correction.
