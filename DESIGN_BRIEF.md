# DESIGN_BRIEF.md — ALVILLAS OS UI and UX

Read before any UI work. Goal: a calm, premium, hospitality-grade product with Airbnb-like clarity. It must not look like a generic template or an AI-generated dashboard. Existing tokens in `src/app/globals.css` (deep green primary `#0B6B5F`, ink `#182326`, warm surfaces `#F5F6F2` / `#EEF3EF`, rust accent `#9F3F1B`) are the base; refine them through a short ADR rather than replacing them silently.

## Direction
- **Airbnb-like qualities, not Airbnb's brand:** photography-first cards on Owner and Guest surfaces, generous white space, one clear primary action per screen, large readable type, soft radius (12–16 px), hairline dividers, almost no shadow (one subtle elevation for floating layers), warm and human microcopy, sticky bottom action bars on mobile, filters and search as simple pills.
- **Premium and professional:** restraint, strong hierarchy, 8 px spacing grid, tabular numerals for all money, nothing decorative without a purpose.
- **Quiet Moroccan identity:** warm neutral surfaces plus one restrained geometric motif (eight-point star lattice) at very low contrast, only in empty states, guest hero overlays and the footer. No clichés (no stock arches, no fake-Arabic fonts, no brochure imagery).
- **Imagery:** every villa has a photo. Use labelled placeholders (3:2, 16:9) until real photos exist; never invent or stock-fill photos.

## System
- One accent colour, near-black ink, white ground plus one warm off-white, muted greys, restrained success/warning/danger. WCAG AA or better.
- One humanist sans for the product; optionally one elegant display face for large headings and large numbers on Owner and Guest only. Never default system look, Inter, Roboto or Arial. Define a type scale; tabular numerals for money. Field app body 17 px or larger.
- Components: buttons (primary, secondary, quiet), labelled inputs, selects, date range, stepper (− n +), toggles, tabs, status badges, tables (56 px rows, sticky headers), cards, modals, toasts, empty / loading (skeleton) / error states. One consistent stroke icon set; no emoji.
- Motion 80–250 ms, subtle. Touch targets 44 px minimum, 48–56 px in the Field app.

## Do not
Gradient washes, glassmorphism, glows, floating blobs; emoji as icons; cards with a coloured left border; walls of identical stat tiles with sparklines; a dark sidebar with pill active states; centered-everything layouts; lorem ipsum or fake logos; "Welcome back!" fluff. Every screen has one obvious thing to do.

## UX rules per surface
- **Owner portal:** money first. Balance as the hero number, where it is held, a statement that ties out line by line, PDF in EN and FR, approvals with what happens next.
- **Guest Hub (mobile):** next step first. Progress ("1 of 4"), check-in unlock message, boutique-concierge tone.
- **Field app (mobile, offline):** next job first. One task at a time, very large buttons, offline is a calm normal state (never an error screen), FINISH disabled until the checklist is complete, supervisors' proxy validation shows "Performed by" and "Validated by" separately.
- **Admin (desktop):** exceptions first. Dense where needed, calm money summary, saved views, keyboard search.
- Hidden financial fields appear masked (••••••), never blank or broken. Every list has designed empty, loading and error states. Plain language; French text runs 20–30 % longer, so layouts must hold; Arabic/RTL must hold (logical CSS properties, mirrored icons).

## Screen inventory (all required in the finished product)
Owner: home (card per villa), villa money and statement, approval detail. Guest: home with steps, chef menu, agreement and signature. Field: Today, checklist, supervisor proxy validation. Admin: Command Center, property workspace (calendar + tabs + side panel), finance (owner ledger, Variance Center), design-system board. Plus one French and one Arabic RTL screen to prove the layouts.

## UI quality checklist (run before every UI PR)
One clear primary action? Hierarchy readable in three seconds? Would it pass as a hand-designed hospitality product rather than a template? Type, spacing, colour and components consistent with the rest? EN, FR and RTL checked? Loading, empty, error, offline states designed? Keyboard and screen-reader basics pass? 360 px width works for mobile screens?
