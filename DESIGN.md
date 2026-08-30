---
name: Kawal
description: An agent marketplace for BNB Smart Chain drawn as an inspection form — carbonless paper, typed entries, and stamps pressed only after Kawal called.
colors:
  paper: "#f1eadb"
  paper-white: "#fbf8f0"
  paper-yellow: "#f2dc8e"
  paper-pink: "#efbcc4"
  paper-blue: "#d2dff0"
  carbon: "#1c1913"
  carbon-2: "#4a453b"
  carbon-3: "#66604f"
  rule: "#2a2620"
  rule-soft: "#a99f86"
  rule-faint: "#d8cfb6"
  stamp-violet: "#4a2a7d"
  stamp-blue: "#1f4e9c"
  stamp-red: "#b5271f"
  stamp-grey: "#5a5850"
  stamp-green: "#2f6b3a"
  seat-rebalancing: "#0e6a71"
  seat-grid: "#2f4a9e"
  seat-yield: "#2f6b3a"
  seat-health: "#b5271f"
  seat-security: "#4a2a7d"
  seat-rebalancing-on-pink: "#0a5057"
  seat-grid-on-pink: "#263d85"
  seat-yield-on-pink: "#25562e"
  seat-health-on-pink: "#8f1e18"
  seat-security-on-pink: "#3d2268"
typography:
  display:
    fontFamily: "Courier Prime, Courier New, monospace"
    fontSize: "2rem (2.6rem from sm; cover sheet 2.1rem / 2.9rem / 3.4rem)"
    fontWeight: 700
    lineHeight: 1.1
    letterSpacing: "normal"
  headline:
    fontFamily: "Barlow Condensed, Arial Narrow, sans-serif"
    fontSize: "1.5rem to 2rem"
    fontWeight: 700
    lineHeight: 1.02
    letterSpacing: "-0.01em"
  title:
    fontFamily: "Barlow Condensed, Arial Narrow, sans-serif"
    fontSize: "1.35rem"
    fontWeight: 700
    lineHeight: 1.02
    letterSpacing: "-0.01em"
  body:
    fontFamily: "Courier Prime, Courier New, monospace"
    fontSize: "15px (0.9rem in manifest rows, 0.78rem in signal lines)"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
  label:
    fontFamily: "Barlow Condensed, Arial Narrow, sans-serif"
    fontSize: "0.72rem"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "0.09em"
  stamp:
    fontFamily: "Barlow Condensed, Arial Narrow, sans-serif"
    fontSize: "1.05rem (lg 1.6rem, sm 0.7rem)"
    fontWeight: 800
    lineHeight: 1.1
    letterSpacing: "0.08em"
  note:
    fontFamily: "Courier Prime, Courier New, monospace"
    fontSize: "0.74rem"
    fontWeight: 400
    lineHeight: 1.35
    letterSpacing: "normal"
rounded:
  none: "0"
  stamp: "3px"
spacing:
  rule: "1px"
  tally-gap: "3px"
  cell: "0.55rem 0.8rem 0.7rem"
  legend: "0.55rem 0.8rem"
  counterfoil: "0.7rem 1rem 0.7rem 1.1rem"
  counterfoil-quiet: "0.45rem 0.75rem 0.45rem 0.85rem"
  page-gutter: "1.5rem"
  page-width: "72rem"
components:
  sheet:
    backgroundColor: "{colors.paper-white}"
    textColor: "{colors.carbon}"
    rounded: "{rounded.none}"
  sheet-yellow:
    backgroundColor: "{colors.paper-yellow}"
    textColor: "{colors.carbon}"
  sheet-pink:
    backgroundColor: "{colors.paper-pink}"
    textColor: "{colors.carbon}"
  cell:
    backgroundColor: "{colors.paper-white}"
    textColor: "{colors.carbon}"
    typography: "{typography.body}"
    padding: "{spacing.cell}"
    rounded: "{rounded.none}"
  cap:
    textColor: "{colors.carbon-3}"
    typography: "{typography.label}"
  counterfoil:
    backgroundColor: "{colors.paper-white}"
    textColor: "{colors.carbon}"
    typography: "{typography.stamp}"
    padding: "{spacing.counterfoil}"
    rounded: "{rounded.none}"
  counterfoil-hover:
    backgroundColor: "{colors.paper-yellow}"
  counterfoil-pink:
    backgroundColor: "{colors.paper-pink}"
  counterfoil-pink-hover:
    backgroundColor: "{colors.paper-white}"
  counterfoil-quiet:
    padding: "{spacing.counterfoil-quiet}"
  counterfoil-disabled:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.carbon-3}"
  field:
    backgroundColor: "{colors.paper-white}"
    textColor: "{colors.carbon}"
    typography: "{typography.body}"
    padding: "0.45rem 0.6rem"
    height: "2.5rem"
    rounded: "{rounded.none}"
  stamp:
    typography: "{typography.stamp}"
    padding: "0.22em 0.55em 0.18em"
    rounded: "{rounded.stamp}"
  legend:
    backgroundColor: "{colors.paper-white}"
    padding: "{spacing.legend}"
  serial:
    textColor: "{colors.stamp-red}"
    typography: "{typography.body}"
---

# Design System: Kawal

## Overview

**Creative North Star: "Surat Jalan" (the escort manifest)**

Every agent is a consignment under escort; the page is the inspection form, and a tier is a stamp Kawal pressed after it called. The lineage is Indonesian escort manifests and customs inspection forms — carbon-copy slips, serial numbers, rubber stamps — but the forms are worded in English throughout: the reference is the stationery, not the language. The scene is a desk under office light with the form flat on it, so the site is light-only (`color-scheme: light`) and has no dark rendition. Every colour is an ink or a paper stock; there is no UI grey.

The form grammar is load-bearing, not decoration. The direction's own risk line: "Paper skeuomorphism reads as novelty if the form grammar is decoration rather than data; every ruled cell must hold a real value and every stamp must be a real outcome, or the world collapses into a theme." That rule decided most of the build: a stamp prints darker with more evidence, a stamp's blind spot is printed under it, the probe history is a tally strip rather than a chart, and every form carries a printed legend.

Confirmed anti-references (from the direction contract and `.impeccable/decision/direction.json`): the hero-plus-cards marketplace and the dark dashboard, which the thesis refuses outright; the "clean crypto marketplace" category standard (neutral ground, cards, sortable table, coloured badges, one accent), recorded as the owner's first-named anti-reference; and charcoal-and-glow, "the neon anti-reference the owner named". The softer failure the risk line guards against is the cream editorial site, where the paper becomes a magazine mood rather than a form that holds data.

**Key Characteristics:**
- Three-part carbonless paper (white, yellow, pink) on a toothed desk-paper ground.
- Two voices only: condensed pre-printing (Barlow Condensed) and typewriter entries (Courier Prime).
- Ruled 1px cells with pre-printed captions; headings live inside cells, never as eyebrows above them.
- Rubber stamps at -8deg, one ink per outcome, ink density tracking evidence count, edges roughened by an SVG filter.
- Perforated counterfoils are the only buttons.
- A punched tally strip for probe history; a printed legend on every form.
- Flat: no shadows, no radius (except the stamp's 3px), no dark mode.

## Colors

Paper stocks and inks only; the palette is a stationery cupboard, not a UI scale.

### Primary
- **Stamp Violet** (`stamp-violet`): Kawal's own mark, HIREABLE — pressed only where Kawal called and something answered in its declared protocol. Also the focus ring (2px dashed), caret, accent colour, and the outline on the newest tally cell.
- **Stamp Red** (`stamp-red`): DOES NOT ANSWER — called, nobody answered. The one verdict Kawal proved rather than read. Also the serial-number ink and the K-0 returned-form stamp.
- **Stamp Blue** (`stamp-blue`): REACHABLE — something answered, not in the declared way. Also the ruler's edge lines.
- **Stamp Grey** (`stamp-grey`): REGISTERED ONLY — declares nothing to call.
- **Stamp Green** (`stamp-green`): CHARGED — quotes a price when asked (x402).

### Secondary
The five seat inks rule the manifest lines. A listing row sets `--seat`, and its bottom rule, serial and category caption take that ink.
- **Rebalancing** (`seat-rebalancing`, teal), **Grid** (`seat-grid`, blue), **Yield** (`seat-yield`, green), **Health** (`seat-health`, red), **Security** (`seat-security`, violet).
- On the pink copy the same five tokens are redefined one step darker (`*-on-pink`) so they clear 5:1 on `paper-pink`; the light values measured 3.8:1 there. Redefining the token on `.sheet--pink` means every rule, serial and caption follows without knowing which sheet it sits on.

### Neutral
- **Paper** (`paper`): the desk, the ground every form lies on. Carries a repeating-gradient tooth (carbon lines at 0.06 / 0.04 alpha, 3px and 4px pitch). Also the disabled counterfoil ground.
- **Paper White** (`paper-white`): the top copy; default sheet, cell, header, footer, legend, field, counterfoil and tally-cell background.
- **Paper Yellow** (`paper-yellow`): the second copy; the carbon offset behind a sheet, the hover state on counterfoils, tabs and manifest rows (35% alpha on rows), the inspected-by cell on the cover sheet, the live-mandate sheet.
- **Paper Pink** (`paper-pink`): the third copy; returned forms (K-0), the mandate's limits sheet, text selection.
- **Paper Blue** (`paper-blue`): the acetate reading ruler stock (token defined; see Review Record).
- **Carbon** (`carbon`): body text and punched tally cells. **Carbon 2** (`carbon-2`): descriptions, passing signal lines, nav tabs; also replaces Carbon 3 on pink. **Carbon 3** (`carbon-3`): captions, stamp notes, placeholders, failing signal lines, unclassified seats; 5.1:1 on paper, 5.6:1 on white, 4.6:1 on yellow, 3.8:1 on pink (hence the override).
- **Rule** (`rule`): every printed border and grid line, 1.5px on sheets, cells, fields and counterfoils, 1px on tally cells. **Rule Soft** (`rule-soft`): legend border, tab dividers, scrollbar thumb. **Rule Faint** (`rule-faint`): defined; nothing in the build reads it yet.

### Named Rules
**The One Ink Per Outcome Rule.** Each stamp ink means exactly one verdict and is never mixed or reused for another meaning: violet = inspected and answered in protocol, blue = reached another way, red = called and silent, grey = nothing to call, green = paid.

**The Pink Copy Rule.** Anything set in Carbon 3 or a seat ink on a pink sheet steps one shade darker. The override lives outside `@layer components` on purpose: Tailwind emits `text-carbon-3` in its utilities layer, which outranks anything inside the components layer, and the first layered version of the rule lost.

**The Ink Density Rule.** A stamp's opacity is its evidence: `0.62 + min(evidence, 90) / 90 * 0.38`. Ten probes press at about two thirds, ninety at full. A stamp given no evidence prints at the base density (0.62): ink it did not earn is ink it does not get. Small stamps are exempt — 11px type at base ink falls under AA — and print full.

## Typography

**Display Font:** Courier Prime (with Courier New, monospace) — the typewriter. Weights 400 and 700.
**Body Font:** Courier Prime — the same voice; entries are typed.
**Label/Form Font:** Barlow Condensed (with Arial Narrow, sans-serif) — the pre-printing. Weights 500, 600, 700, 800.

**Character:** Two voices only, as on every carbon form. Everything the printer put down before the form reached the desk (captions, section headings, stamps, counterfoils, tabs) is condensed grotesque; everything Kawal or the visitor entered (H1s, values, descriptions, notes, serials, inputs) is typed. Numbers are tabular everywhere (`font-variant-numeric: tabular-nums` on body).

### Hierarchy
- **Display** (Courier Prime 700, 2rem, 2.6rem from `sm`, line-height 1.1, `text-balance`): the H1 of every form, typed as the form's first entry. The cover sheet runs larger (2.1 / 2.9 / 3.4rem, line-height 1.08) and is capped at 16ch; other H1s cap at 18–24ch where they wrap.
- **Headline** (Barlow Condensed 700, 1.5–2rem, line-height 1.02, -0.01em): pre-printed section headings (`.heading`): "Hire by the job", seat names in the K-2 manifest, the site name in the header (1.5rem).
- **Title** (Barlow Condensed 700, 1.35rem): agent names on manifest rows and seat names on K-0.
- **Body** (Courier Prime 400, 15px, line-height 1.5): typed entries and cell values; descriptions at 0.9rem in Carbon 2; signal and probe lines at 0.78rem.
- **Label** (Barlow Condensed 600, 0.72rem, 0.09em, uppercase, Carbon 3): the pre-printed field caption (`.cap`) inside a cell, the form-code strip, the legend key, the footer.
- **Stamp** (Barlow Condensed 800, 1.05rem, 0.08em, uppercase): stamp faces. Counterfoils use the same face at 700 / 1rem / 0.06em, nav tabs at 600 / 0.9rem / 0.05em.
- **Note** (Courier Prime 400, 0.74rem, line-height 1.35, Carbon 3): the line under a stamp that says what the stamp cannot see (`.stamp-note`).
- **Serial** (Courier Prime, 0.06em, Stamp Red): numbering-machine strikes — `No. K1-288290`, token ids, form codes beside tab names.

### Named Rules
**The Typed H1 Rule.** Every H1 is typed (Courier Prime 700), and nothing sits above it: no eyebrow, no kicker in the condensed face. The form's own caption strip (`Form K-3 · inspection sheet`) is the sheet's header cell inside the sheet's rule, not an eyebrow.

**The Two Voices Rule.** If it was printed before the form reached the desk, it is Barlow Condensed; if it was entered on the desk, it is Courier Prime. No third face, no system display face.

## Layout

One column of forms, 72rem wide (`max-w-6xl`), 1.5rem side gutters, centred on the desk-paper ground. The header is a paper-white strip ruled off at 1.5px with the site name at left and the book's tabs at right (K-2 Agents, K-5 Mandate, K-7 Evidence, K-6 My Agents); each tab prints its form code in serial red beside the name, hidden from the accessible name. The footer is the same strip ruled at the top, carrying two captions.

A form is a `.sheet`; a page's main sheet is `.sheet--carbon`, which stacks the yellow and pink copies beneath it at 6px and 12px offsets to the bottom-right. Inside, a `.cells` grid uses the gap as the rule (1px gap and 1px padding on a rule-coloured grid, plus a 1px ring on each cell). Cells stack on a phone and go to columns from `sm` (three registry cells on K-1, two-column manifest rows). Cell padding is 0.55rem top, 0.8rem sides, 0.7rem bottom, with the caption on its own line and 0.35rem beneath it.

Manifest rows are single-column on a phone (stamp and serial drop under the description) and two-column from `sm` with the stamp column right-aligned. The tally strip wraps at 21rem. The cover-sheet stamp shrinks one step under 640px (`.stamp-responsive`) so it can still cross the count's last digit without leaving its cell.

Motion is limited to the stamp press (380ms, scale 1.22 → 1 at the fixed -8deg, `cubic-bezier(0.18, 0.9, 0.24, 1)`) and the counterfoil's 120ms translate/background transition; both are removed under `prefers-reduced-motion`.

## Elevation & Depth

No shadows. Depth is the paper itself: a sheet reads as lying on the desk because its yellow and pink copies peek out beneath it at a fixed offset (the carbon stack), and cells read as ruled because their borders are the printed grid, not elevation. The only `box-shadow` in the system is the 1px ring that draws a cell's rule. Stamps sit into the paper rather than on it: `mix-blend-mode: multiply` plus the `#stamp-ink` SVG filter (fractal-noise displacement at scale 1.3 for the edge, then a second noise pass that drops the print where pressure was light); small stamps use `#stamp-ink-fine` (edge displacement at 0.8 only) so their text stays legible. Both filters are defined once in `app/layout.tsx`.

### Named Rules
**The Flat Paper Rule.** Nothing floats. No drop shadows, no glows, no blur, no glass. If an element needs to read as separate, give it a rule or a different paper stock.

## Shapes

Square corners everywhere; the only radius in the system is the stamp's 3px, the rounded corner of a rubber die. Borders are 1.5px solid Rule on sheets, cells, fields and counterfoils, 1px on tally cells. Counterfoils tear from the left: the left edge is 1.5px dashed, the rest solid; disabled counterfoils go dotted. Stamps are a 3px double ring (4px large, 2px small) in their ink colour, rotated -8deg with the origin at 50% 60%. The -8deg is the page's one angle; nothing else is rotated.

## Components

### Counterfoil (button / primary link)
The tear-off stub is the action; the only button style in the system.
- **Shape:** square, 1.5px solid Rule with a dashed left edge (the perforation).
- **Primary:** paper-white ground, carbon text, Barlow Condensed 700 1rem uppercase 0.06em, padding 0.7rem 1rem 0.7rem 1.1rem, 0.6rem gap for an arrow or inline mark.
- **Hover / Focus:** ground turns paper-yellow and the stub slides 2px right (seating into the sheet); active adds 1px down. Focus is the global 2px dashed violet outline at 3px offset.
- **Quiet:** weight 600, 0.82rem, smaller padding; the secondary stubs ("See the limits", "Back to the manifest", per-row "Open form").
- **Pink:** paper-pink ground, white on hover; the mandate's revoke stubs.
- **Disabled:** dotted border, Carbon 3 text, desk-paper ground, no transform, `cursor: not-allowed`.

### Stamp
A rubber stamp: double ring, condensed caps, one angle, ink multiplied into the paper.
- **Sizes:** md 1.05rem / 3px ring; lg 1.6rem / 4px ring (the cover-sheet verdict, K-0's returned stamp); sm 0.7rem / 2px ring, 0.1em tracking (tier stamps on rows, legend keys).
- **Ink:** one of the five stamp inks via `ink`; `tierInk()` maps hireable → violet, reachable → blue, unreachable → red, otherwise grey.
- **Density:** `evidence` sets `--ink` per the Ink Density Rule.
- **Flat:** `flat` removes the rotation and the press animation for stamps inside table cells and the legend, where a rotated block would collide with the rule.
- **Language:** English throughout, so a stamp reads the same by eye as it does to a screen reader. `TierStamp` prints `tierLabel(tier)` and nothing else: the face used to be a separate Indonesian die with the English tier hidden beside it in an `sr-only` span, which meant two vocabularies to keep in step. There is no `title` prop — information that only lives in a tooltip is information a phone never shows.
- **Pink copy:** on `.sheet--pink` the stamp inks step darker with the seat inks (grey, red, blue, green), all measured ≥5:1 on the pink.
- **Note:** a large stamp carries a `.stamp-note` beneath it stating its blind spot ("single vantage point · an endpoint that blocks this prober reads as down").

### Sheet
- **Corner Style:** square, 1.5px Rule border.
- **Background:** paper-white by default; `--yellow` and `--pink` variants for the second and third copies.
- **Carbon stack:** `--carbon` draws the yellow and pink copies beneath at 6px / 12px offsets (z-index -1 / -2).
- **Header strip:** a `.cap` row inside the top rule carrying the form code (`Form K-n · what the form is`), serial and date.

### Cells
- **Grid:** `.cells` with the 1px gap as rule; each `.cell` holds a `.cap` caption on the first line and a typed value below; `tone` switches the stock to yellow or pink; `span` widens across columns.
- **Padding:** 0.55rem 0.8rem 0.7rem.

### Fields / Inputs
- **Style:** typed (Courier Prime 0.95rem), paper-white, 1.5px Rule border, square, 0.45rem 0.6rem padding, 2.5rem minimum height; placeholder in Carbon 3; caret and accent in Stamp Violet.
- **Focus:** the global dashed violet outline.
- **Submit:** a counterfoil.

### Navigation
- **Tabs:** Barlow Condensed 600 0.9rem uppercase 0.05em in Carbon 2, divided by 1px Rule Soft, with the form code in serial red beside the label; hover turns the tab paper-yellow and the text Carbon. Same treatment at every width; tabs wrap.

### Manifest Row (signature)
One consignment line on Form K-2. Sets `--seat` from the category; the 1.5px bottom rule, the serial (`No. {token_id}`) and the category caption take that ink. Left: the agent name (Title), description (0.9rem Carbon 2), and the signal list as 9px punched squares (carbon when passing, blank when not) with a typed line each. Right: the tier stamp (small, flat, density from the observed signal's `evidence`) and, only when Kawal actually called, a probe line with a 9px violet or red square that prints the tool or skill count in plain text. When the manifest is selectable each row carries a tick box labelled `Bandingkan · compare`, posting to Form K-4. Each punched square's meaning is spoken as "passes:" / "fails:" for a reader who cannot see the fill. Hover washes the row paper-yellow at 35%.

### Tally (signature)
The probe history as a perforated tally strip: 11px cells with a 1px Rule border on paper-white, 3px gap, punched carbon when the call answered, blank when it did not, the newest outlined 2px violet — on the punched side when the newest call answered, the blank side when it did not, and not drawn at all when that is unknown. Drawn from counts (up to `cap`, default 60, 40 on K-6) with the punched cells distributed proportionally; the strip carries `role="img"` and an `aria-label` of "N of M calls answered". Never a chart.

### Legend (signature)
Every form carries its key: a `<section aria-label="Legend">` — a 1px Rule Soft box on paper-white opening with the caption `Key`, followed by a `<dl>` pairing each mark in use on that page (a small flat stamp, a punched square) with its typed 0.8rem Carbon 2 meaning. Pass only the entries the page actually uses.

### Serial
Courier Prime at 0.06em in Stamp Red: the numbering machine's strike. `.serial--seat` takes the row's seat ink instead.

## Do's and Don'ts

### Do:
- **Do** put a real value in every ruled cell and a real outcome behind every stamp; a cell without data or a stamp without a call is the world collapsing into a theme.
- **Do** pass `evidence` to any stamp whose verdict rests on probes, so its ink prints at the density it earned.
- **Do** print the blind spot under a large stamp as a `.stamp-note` in the typed face.
- **Do** give every new form a `Form K-n` caption strip, a serial in Stamp Red, and a `Legend` listing only the marks that page uses.
- **Do** type every H1 in Courier Prime 700 at 2rem / 2.6rem (the cover sheet is the one larger exception).
- **Do** set every button and primary link as a `.counterfoil` (quiet for secondary actions), and every input as a `.field`.
- **Do** set `--seat` on any element ruled in a seat's ink so the pink-copy override follows it.
- **Do** write pink-copy contrast overrides unlayered (outside `@layer components`), since Tailwind utilities outrank the components layer.
- **Do** keep -8deg as the page's only angle and the stamp press as its only entrance motion, both removed under reduced motion.

### Don't:
- **Don't** build a dark dashboard, a neon or charcoal-and-glow surface, or add a dark mode; the scene is a desk under office light and `color-scheme` is light only.
- **Don't** build the hero-plus-cards marketplace or the "category standard" (neutral ground, cards, sortable table, coloured badges, one accent); it is the owner's first-named anti-reference.
- **Don't** let the paper soften into a cream editorial mood; a sheet exists to hold data in ruled cells, not to set a tone.
- **Don't** put an eyebrow or kicker in the condensed face above an H1; captions belong inside cells and sheet header strips.
- **Don't** use shadows, glows, blur, glass, or radius beyond the stamp's 3px.
- **Don't** introduce a UI grey, a third typeface, a badge, a pill, or a card; a status is a stamp, a group is a sheet or a cell, an action is a counterfoil.
- **Don't** reuse a stamp ink for a second meaning or mix inks on one stamp.
- **Don't** draw probe history as a chart; it is a tally strip.
- **Don't** mark a listing as checked by omission; a row with no probe line means unchecked, never "checked and fine".
- **Don't** let the cover-sheet stamp cross more than the count's last digit, at any width.

## Forms

The site is a book of numbered forms; the code prints in the sheet's caption strip and beside the tab name.

| Code | Route | File | What it is |
|---|---|---|---|
| K-0 | 404 | `app/not-found.tsx` | Returned. A pink sheet with a large red stamp; the four seats offered as a way back; quiet counterfoils to the manifest and the cover sheet. |
| K-1 | `/` | `app/page.tsx` | Cover sheet. Carbon-stacked sheet: serial and date strip; typed H1 at left; the probe count in a yellow cell at right with the violet HIREABLE stamp (density from the count) crossing its last digit and the blind-spot note beneath; three registry cells labelled as the registry's; the BROWSE AGENTS counterfoil plus two quiet stubs; the legend; the four seats as numbered manifest lines under a Form K-2 caption. |
| K-2 | `/agents` | `app/agents/(list)/page.tsx` | Agent manifest. Carbon-stacked sheet with a typed H1 (the seat name when filtered), a filter field with quiet counterfoils (submit, compare), the listing rows, and the legend. |
| K-3 | `/agents/[chainId]/[tokenId]` | `app/agents/[chainId]/[tokenId]/page.tsx` | Inspection sheet for one agent. Carbon-stacked sheet, typed H1 = agent name, the tier stamp, the probe tally strip and history, the legend; a quiet counterfoil back to the manifest. |
| K-4 | `/compare` | `app/compare/page.tsx` | The same questions asked of each. Two or three agents as columns on one carbon-stacked sheet; the H1 is the agent names joined by ` · `. The empty state is its own sheet with a stub to the manifest. |
| K-5 | `/mandate` | `app/mandate/page.tsx` | The mandate. Carbon-stacked sheet for the H1; a pink sheet for the limits form with a primary counterfoil submit; a yellow sheet for the live mandate with pink quiet counterfoils; the legend. |
| K-6 | `/owner` | `app/owner/page.tsx` | Owner sheet, for the other side of the listing. Carbon-stacked sheet, H1 "Is your agent still answering?", a lookup field with a counterfoil, and per-agent tally strips capped at 40. |
| K-7 | `/advantage` | `app/advantage/page.tsx` | Agent advantage report. Carbon-stacked sheet of measurements; the empty state is a plain sheet with the H1 "No measurements yet." |

## Provenance

- **Direction:** Surat Jalan, candidate 7 of 7 from the build's own grounded list, seed key `dc528c41` (assigned index 7). Recorded in the `CONTRACT` string in `app/layout.tsx` ("FORM: Surat Jalan, candidate 7 of 7, seed dc528c41") and corroborated by the concept-seed output for key `dc528c41`.
- **Decision:** `.impeccable/decision/direction.json` records the user's choice as `optionId: assigned` (Surat Jalan) with `buildPath: code`. That file carries no seed field; the seed above comes from the contract and the seed output, not from the decision record.
- **Raises** (disciplines borrowed from declined challengers, named in the contract and the decision record): chromatophore → ink density tracks evidence; cloud edge → uncertainty printed under every stamp; rocket plate → one angle (-8deg); orienteering → a legend on every form; drum machine → the tally strip; HyperCard → addressable counterfoils (tx hashes, probe records and seats deep-link).
- **Weighed and declined:** Counted Marks (model pick), Iridescent Cloud Edge, Orienteering Map, Chromatophore Skin, Pulp Rocket Plate, Drum Machine Step Row, HyperCard Shoebox, and the category-standard canon card.
- **Surface brief:** `.impeccable/surfaces/app-page-tsx.md` (cover sheet; headline and the three link names pinned by the suite; no eyebrow above the H1).

## Review Record

Three finish-review passes ran after the fix pass; screenshots are in `.impeccable/review/` (`desktop.png`, `mobile.png`, `desktop-agent.png`, `desktop-compare-empty.png`, `desktop-mandate.png`).

- **Fix pass:** 8 findings, all applied.
- **Verdict 1:** 3 open, applied.
- **Verdict 2:** 3 open, applied.
- **Verdict 3:** ship.

Rules the review established, now carried in the code:
- No eyebrow captions above H1s in the condensed face; every H1 is typed Courier Prime.
- The pink-copy ink overrides are unlayered, because Tailwind utilities outrank `@layer components`.
- The cover-sheet stamp crosses only the count's last digit (`.stamp-responsive` shrinks it under 640px).
- An axe pass forced darker seat inks on the pink copy; the five `*-on-pink` values clear 5:1.

`.fill`, `.ruler` and the `.label` alias were defined in `app/globals.css` and used by no form; they were removed after this record was written rather than left as an untested promise. `--paper-blue` stays as a palette token. `rule-faint` is in use (the manifest's loading skeleton).
