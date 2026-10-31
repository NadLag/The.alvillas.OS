# ADR 0131 — Render custom role editors when opened

Identity administration lists every authorized role summary while mounting a custom role's permission editor only when its disclosure is first opened. The mounted editor remains in place after closing, preserving an unsaved draft. Opening, editing, saving and keyboard behavior use the existing form, labels, validation and server actions.

The full CI fixture includes the additional actual roles created by monthly compensation journeys. Rendering a complete permission checklist inside every closed role disclosure delayed action results and exhausted the unchanged 90-second mobile Identity lifecycle. This change bounds permission controls to the create form and the editors explicitly opened by the user. It does not cache authority, change catalog visibility, alter role assignments, or relax financial and operational permissions.

Native acceptance creates one hundred actual custom roles through the application service, verifies every summary remains available, opens an editor by keyboard, saves and checks actual stored permissions, and confirms an unsaved draft survives closing and reopening. The original Identity lifecycle timeout and assertions remain unchanged.
