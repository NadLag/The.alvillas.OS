# ADR 0114: Authorize saved compensation runs and source labels separately

Status: Accepted for integration; full compensation and staging acceptance remain outstanding.

The compensation workspace lists only concrete runs authorized for the complete artifact amount and every original beneficiary salary source. Caller restrictions intersect freshly stored grants. A bounded scan returns at most ten visible runs; its encrypted continuation binds the actor, organization and filters so a hidden run identifier never becomes a public cursor. A list receipt contains only disclosed run identifiers. Source reloads and a final authority check precede the response.

Saved-run detail reuses the canonical audited financial read. Human labels are an additional disclosure boundary: independently scoped identity access controls names, property access controls property names, and task access controls the original localized work title. A person's actual account binding permits their own name. Completion method, performer and distinct proxy validator come from the actual immutable completion event. Source identity is never inferred from a supplied snapshot or a currently assigned worker. Every disclosed label requiring permission is checked again before return.

The localized workspace keeps financial responses in memory, with private no-store HTTP responses and no offline financial-command queue. Reads clear data before revalidation and on connection loss or denial; aborted generations cannot repopulate it. Cancellation retains one immutable intent during an uncertain acknowledgement and retries that exact command. Its append-only server receipt retains the original run and work evidence. Draft expectations remain separate from approved employee claims, journal recognition and payment.
