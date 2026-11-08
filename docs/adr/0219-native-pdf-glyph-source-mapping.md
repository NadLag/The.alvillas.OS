# ADR0219 — Preserve native PDF source characters

A French document can prime a cached fontkit glyph without its character
mapping. A later PDF then embeds an empty Unicode mapping for that glyph.
The retained production artifact and an isolated renderer test reproduce
uppercase E becoming a control character after an accented French render.
Upstream tracks the underlying cache behavior in
[react-pdf issue 3404](https://github.com/diegomura/react-pdf/issues/3404).

Initialize the existing local Source Sans 3 fonts before rendering. For those
two registered font instances only, preserve supplied source characters when
the underlying glyph has no character mapping. Return a glyph clone for that
lookup rather than mutate the shared cached glyph. Retain its prototype and
geometry. Existing mapped glyphs pass through unchanged.

Document and accounting renderers await the same initialization promise.
There is no global font reset, dependency patch, new font registry or change
to Arabic provider requirements. Sequential, mixed-accent and concurrent PDF
tests check exact clauses and Money. Existing PDFs, financial rows and signed
history remain untouched; the fix applies to newly rendered output.
