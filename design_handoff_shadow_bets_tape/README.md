# Handoff: Shadow Bets — Direction A (Tape)

## Overview
Mobile redesign of Shadow Bets, a model-driven sports betting companion app. The model produces ~45 graded plays per morning across MLB / EPL / NFL; the user's job is to decide which of them to **take**, which to **fade** (bet the opposite side), and which to **pass** — then watch those positions settle through the day.

Direction A ("Tape") renders the whole slate as one continuous hairline ledger rather than cards. Four screens are specified here: **Picks · Build mode**, **Picks · Watch mode**, **Results**, and **Scores**.

## About the Design Files
The files in this bundle are **design references created in HTML** — static prototypes showing intended look, layout, and states. They are not production code to copy directly, and they contain no JavaScript or real interactivity: every state (selected tri-state, expanded game, live score) is hardcoded markup.

The task is to **recreate these designs in the target codebase's existing environment** (React Native, SwiftUI, React web, etc.) using its established patterns, component library, and data layer. If no environment exists yet, choose the framework appropriate to the project (this is an iOS-first phone design; 390×844 logical points) and implement there.

Note: an earlier, fully interactive React prototype of the *previous* version of this app exists in the project as `Shadow Bets.html` — useful for reading existing data shapes and behaviors, but its visual design is superseded by this direction.

## Fidelity
**High-fidelity.** Colors, typography, spacing, row heights, and column widths are final and specified exactly below. Recreate pixel-perfectly using the codebase's own primitives. The one deliberate placeholder is team logos (see Assets).

---

## Design Tokens

### Color
| Token | Value | Use |
|---|---|---|
| `bg` | `#0A0B0D` | screen background, row background |
| `panel` | `#101216` | slate strip, tab bar, footer panels |
| `panel2` | `#15181C` | rule bar |
| `panel3` | `#0C0E11` | game header, legend strip, day header, "more" row |
| `line` | `#1F242A` | primary hairline (1px) between sections |
| `line-soft` | `#14171B` | hairline between rows inside a game |
| `line2` | `#2A3138` | control borders, neutral bar fill |
| `text` | `#E7E9EC` | primary text and numbers |
| `dim` | `#79818B` | secondary text, price column |
| `dim2` | `#7C848F` | labels, market codes, tier ticks |
| `take` | `#4C9AFF` | my bet / take state, active accents |
| `fade` | `#FF8A3D` | fade state |
| `win` | `#34C77B` | winning P/L, live indicator |
| `loss` | `#E5484D` | losing P/L |

Derived fills: take row tint `rgba(76,154,255,0.05)`; fade row tint `rgba(255,138,61,0.05)`; take button fill `rgba(76,154,255,0.14)` with border `rgba(76,154,255,0.45)`; ruler active segment `rgba(76,154,255,0.13)` / border `rgba(76,154,255,0.5)`. Take-row unit text lightens to `#CFE4FF`; fade-row unit text to `#FFD6B3`.

### Typography
Two families only.
- **IBM Plex Sans** — body, team names, selection labels. Weights 400/500/600/700.
- **IBM Plex Mono** — every number, every uppercase label. Tabular figures required (`font-variant-numeric: tabular-nums`) so negative American odds and 0.46u decimals stay aligned.

| Role | Font | Size / weight / tracking |
|---|---|---|
| App title | Sans 600 | 13px, `0.14em`, uppercase |
| Header meta (right of title) | Mono 500 | 10px, `0.06em` |
| Section label ("PLAYS", "RULE · TIER THRESHOLD") | Mono 500 | 9px, `0.13em`, uppercase |
| Stat value (slate strip) | Mono 600 | 19px, `-0.02em` |
| Stat value (results grid) | Mono 600 | 24px, `-0.03em` |
| Unit column | Mono 600 | 17px, `-0.02em`; the `u` suffix is 9px in `dim2` |
| Price column | Mono 400 | 11px |
| Selection label | Sans 500 | 13px / 1.1 |
| Selection qualifier (`· fading LAD`) | Sans 400 | 13px, `dim` (or `fade` on fade rows) |
| Market code (ML / SPR / TOT) | Mono 500 | 9px, `0.1em` |
| Team monogram chip | Sans 700 | 8px at 22px chip, 6px at 16px chip |
| Live P/L | Mono 600 | 15px, `-0.02em` |
| Tri-state glyph | Mono 600 | 9px |
| Tab label | Mono 500 | 9px, `0.09em`, uppercase |

### Spacing & geometry
Horizontal page inset **14px** (12px on the right of action rows). Row gap inside a row: **9px**. Radius: **0 for all surfaces** — cards do not exist. Radius is reserved for controls only: 3px (ruler segments, legend keys), 4px (buttons, tri-state, chips at 16px use 4px / 22px use 5px), 50% (pips, live dot).

Standard heights: build row **46px**, score row **44px**, condensed game row **44px**, tri-state control **28px**, primary button **38px**, tab bar **76px** (with 18px bottom safe-area padding), status bar **52px**.

---

## Screens

### Common chrome (all four screens)

**Header** — 2px top / 10px bottom padding, 16px sides. Baseline-aligned flex row: screen name left, run status right (`WED AUG 26 · RUN 06:15 OK`, `18 POSITIONS · LOCKED 07:04`, `LAST 30 DAYS ▾`, `5 LIVE · UPDATED 1:56P`).

**Slate strip** — 3 equal columns, 1px `line` top and bottom, `panel` background, 1px `line` divider between columns (none after the last). Each cell: 10px/14px padding, label above value, 4px gap. Values may carry a smaller `dim` suffix (`10.9` + `u`, `18` + `/45`). A value turns `take` blue when it represents progress ("Locked 18/45"), `win` green when it is positive P/L.

**League row** — full-width flex, 1px `line` bottom. Each button flexes equally with a 1px `line` right divider, 9px/8px padding, league code above count. Last button is a fixed 42px sort affordance (`⇅`). Selected button: `panel` background, `text` league code, `take` count. On Scores the row switches to filter semantics: ALL / MINE / LIVE / MLB.

**Tab bar** — 4 tabs: Picks, Scores, Props, Results. `panel` background, 1px `line` top. Icon is a 16px 1.4px-stroke rounded square placeholder — **replace with real icons**. Active: icon border `take`, fill `rgba(76,154,255,0.22)`, label `take`.

---

### 1. Picks · Build mode
**Purpose.** Triage the morning slate. Set a tier rule to commit most of it in one gesture, then hand-adjust the rest.

**Rule bar** (the signature element). `panel2` background, 1px `line` bottom, 11px/14px/12px padding, 9px vertical gap.
- Top line: label `RULE · TIER THRESHOLD` left; right side reads `commits` + bold `take`-colored `18 picks · 6.2u`, live-updating as the handle moves.
- **Ruler**: 30px tall, 3 equal segments (tier 10 / 7 / 5), 2px gaps, each a 1px `line2` bordered 3px-radius box on `#0D0F12` containing the tier number (Mono 600 12px) over a pick count (Mono 500 8px, `0.08em`). Segments at or above the threshold are "on": blue tint fill, `rgba(76,154,255,0.5)` border, `#A9CFFF` number. A 2px `take` handle sits on the active boundary, extending 4px past the ruler top and bottom, with an 8px glow (`0 0 8px rgba(76,154,255,0.7)`) and a 10×10px 2px-radius grab square centered on it. **Dragging the handle is the primary interaction on this screen** — segments light up, counts and the commit consequence recompute continuously.
- **Action row**: `1fr auto` grid, 8px gap. Primary `Take 18 · 6.2u` — solid `take` fill, `#03142C` text, Sans 600 12px `0.09em` uppercase, 4px radius, 38px. Secondary `0.3u+` — transparent, 1px `line2` border, `dim` text, 14px side padding; this is a second rule dimension (minimum unit size).

**Legend strip** — directly below the league row, above the tape. `panel3` background, 1px `line` bottom, 7px/14px padding, 13px gap. Three keyed items: `–` Pass, `✓` Take, `F` Fade the model, each key rendered as a 16×15px 3px-radius box matching its real control state (pass = `#0D0F12` on `line2`; take = solid `take`; fade = solid `fade`). Right-aligned: `Tick = tier`. Mono 500 9px `0.09em` uppercase. This strip exists purely to teach the two non-obvious encodings; consider hiding it after N sessions.

**Game group** — 1px `line` bottom. Header: `panel3` background, 8px/14px/7px padding, 8px gap — league code (26px fixed, Mono 600 9px `0.1em`), a **logo pair** (two 16px chips, 3px gap), away team, `@`, home team, then start time right-aligned (Mono 500 10px).

**Market row** — 46px, 5-column grid `3px 1fr 54px 46px 72px`, 9px gap, 12px right padding, 1px `line-soft` top (none on the first row of a group).
1. **Tier tick** — 3px wide bar in the left gutter, bottom-aligned with 9px bottom margin. Height encodes tier: **26px = tier 10, 17px = tier 7, 9px = tier 5**. Color: `dim2` when passed, `take` when taken, `fade` when faded. This replaces a tier badge so that unit size is the only loud number in the row.
2. **Market cell** — 6px left padding, 8px gap: market code (24px fixed), 22px team chip, selection label (single-line, ellipsis). On fade rows the label carries a qualifier `· fading LAD` in `fade` color.
3. **Unit** — right-aligned, the loudest element in the row.
4. **Price** — right-aligned American odds.
5. **Tri-state control** — 28px tall, 1px `line2` border, 4px radius, three equal cells divided by 1px `line2`, background `#0D0F12`. Glyphs `–` / `✓` / `F` in Mono 600 9px `dim2`. Active take cell: solid `take`, `#03142C` glyph. Active fade cell: solid `fade`, `#2B1200` glyph. Exactly one cell is active at all times; default is `–` unless the rule has committed the row. Tap targets are only ~24×28px, which is under the 44px guideline — **widen the hit area with invisible padding, or make the whole row swipeable left/right as an alternative input.**

**Row state background** — taken rows get the blue tint, faded rows the orange tint, passed rows stay `bg`. State, not outcome: nothing on this screen encodes win/loss.

**"+N markets" row** — `panel3`, 7px/14px/8px padding with 32px left indent (aligning past the gutter), Mono 500 10px `0.06em` `dim2`: `+ 1 market · spread 1.5 · tier 5`. Tapping expands the suppressed low-tier markets for that game.

### 2. Picks · Watch mode
Same tape, same rows, different column meaning after lock. This is a mode of the Picks tab, not a separate destination — the transition should feel like the columns changing job, not a navigation.

- Slate strip becomes Live `11/18` · At risk `6.2u` · Day P/L `+1.34u` (green).
- The rule bar is replaced by a **6px tape bar**: a single flush row of segments proportioned to the day — `win` 38%, `line2` 24% (neutral/pending), `loss` 24%, `panel2` 24% (not started). 1px `line` bottom.
- Passed rows disappear; only the 18 positions show.
- Row grid becomes `3px 1fr 54px 46px 72px` reused as: tick, market cell, **price**, **live P/L**, **progress bar**. The tri-state is removed (`.locked`) — decisions are no longer editable.
- **Live P/L** — Mono 600 15px right-aligned: `win` green when up, `loss` red when down, `dim` at zero. Pre-game positions show the staked unit instead (`0.44u`) in `dim`, which reads as "no P/L yet" without an extra column.
- **Progress bar** — 4px tall, 2px radius, track `#191D22`, fill `win` (or `loss`) sized to the model's live win probability. Neutral positions fill `line2` at 50%. Pre-game fills 0.
- Game header gains live state: score numbers (Mono 600 12px) between team names, and a right-aligned live indicator — 5px `win` dot + clock (`67'`, `T7`). Final games use a `#565E68` dot and the label `FINAL`.
- Fade rows that have won read `· fade won` in the qualifier slot.

### 3. Results
**Purpose.** Answer "is the model working" and "did today go how it should have."

- **Stat grid** — 2×2, 1px `line` dividers between cells (not on outer right/top), 13px/14px padding. Record `218–184` with a 12px `#565E68` `–7` push suffix; Win % `54.2`; Units `+16.4` (green); ROI `+4.1%` (green).
- **Unit curve** — 120px tall, 14px/14px/10px padding, 1px `line` bottom. 30 bars, `flex:1` each with 2px gaps, 1px radius, min-height 2px. Positive bars `take` at 0.9 opacity; negative bars `loss` at 0.55. A 1px `line2` zero line sits 38px from the bottom, and a caption `UNIT CURVE · 30D` (Mono 500 9px `0.1em`) is absolutely positioned 12px from top, 14px from right. Bars are cumulative units — in a real build this should be a line or area chart if the data is truly cumulative; bars imply per-day.
- **Day header** — `panel3`, 1px `line` bottom, 9px/14px/7px padding: `Tue Aug 25 · 14 graded` left, day total right in `win`/`loss` color.
- **Log row** — 5-column grid `14px 16px 1fr auto auto`, 9px gap, 9px/14px padding, 1px `line-soft` bottom: result letter (`W` `win` / `L` `loss` / `P` `dim2`, Mono 700 11px), 16px team chip, selection name (Sans 500 12px `#CFD4DA`, with an 11px `dim2` qualifier — league, matchup, or `fade` / `push`), price (Mono 400 10px `dim2`), unit delta (Mono 600 12px, 52px fixed right-aligned, colored to match the result).
- **System health footer** — pinned to the bottom of the scroll region (`margin-top:auto`), `panel` background, 1px `line` top. Header: 6px `win` dot, `SYSTEM HEALTH` label, right-aligned `1 warning` (Mono 400 10px `dim2`). Then key/value rows at 5px/14px, Mono 400 10px: label `dim2`, value `#C4CAD1` 500. A warning row colors its value `fade`. Rows: last successful run, daily validation, odds layer staleness, running CLV. The dot should reflect worst status: `win` / `fade` / `loss`.

### 4. Scores
**Purpose.** Follow the games — with positions always visible in the same view, so the user never has to cross-reference Picks against a scoreboard.

**Filter row** replaces leagues: ALL 16 / **MINE 9** / LIVE 5 / MLB 11. MINE is the default.

**Expanded game** (exactly one at a time, in-tape rather than in a modal):
- Live game header as in watch mode.
- **Score rows** — 44px, grid `3px 1fr 46px 42px 50px`: tick, market cell, price, staked unit (Mono 500 12px `dim`), live P/L. Same take/fade row tints.
- **Line score** — `panel3`, 1px `line-soft` top, 11px/13px/12px padding, grid `1fr repeat(6,25px)`, 7px row gap. Header row of inning numbers + `T`; one row per team (Sans 500 11px `dim`) with per-inning runs centered (Mono 500 11px `#C4CAD1`), total in `text` 600. Not-yet-played innings show `·`. This block is sport-specific — swap for period/quarter equivalents in EPL/NFL.
- **Situation line** — 10px/13px/11px padding, 5px gap: `Pitch 6 · strike 2 foul` (Sans 500 12px `text`) over `1 OUT · AB J. FERNANDEZ · P M. BOYD` (Mono 400 10px `dim2`).
- **Player stat rows** — grid `28px 1fr auto`, 9px gap, baseline-aligned, 4px/13px: role key (Mono 500 9px `0.11em` `dim2`), name + team (Sans 500 11px `#C4CAD1`, team in 10px `dim2`), stat line (Mono 400 10px `dim`).
- **Meta strip** — `panel3`, 1px `line-soft` top, 5px top margin, 9px/13px/10px padding, 11px gap, Mono 400 9px `dim2`: records, venue, broadcast.

**Condensed section** — a divider row (`Other games · 15` / `▾ tap to open`, `panel3`, `line` top and bottom, Mono 500 9px `0.13em` uppercase), then one 44px row per game: grid `26px auto 1fr auto 40px 50px`, 8px gap, 13px left / 12px right padding, 1px `line-soft` top.
1. League code — `dim2`, or `win` green when the game is live.
2. **Logo pair** — two 16px chips.
3. Matchup — Sans 500 12px `text`, with `at` in `dim2` 400, single-line ellipsis.
4. Score or start time — Mono 600 12px `text`.
5. **Position pips** — the key addition. A right-aligned 3px-gap row of 6px circles, **one per position on that game**: `take` blue for a take, `fade` orange for a fade, `#252B31` hollow for a game with no position. Beyond 3 pips, show 3 and append `+N` (Mono 500 9px `dim2`). This replaces a text count and lets the user scan exposure down the whole list at a glance.
6. Day P/L for that game — Mono 600 15px, `win` / `loss` / `dim`. Pre-game rows show staked units in `dim` instead.

---

## Interactions & Behavior
No animation is specified in the prototypes; keep motion minimal and functional.

**Build mode**
- Drag the rule handle → segments re-tint, per-segment counts and the commit line recompute continuously (no debounce; this must feel like a physical scrub).
- Tap the primary button → commits every pick at or above the threshold to `take`, transitions Picks into watch mode. This is destructive-ish; confirm or offer undo.
- Tap a tri-state cell → sets that row's state, updates the tint, tick color, and the slate strip's At risk / Locked figures. Rows manually set should survive a subsequent rule change (rule sets defaults, hand edits win).
- Tap `+N markets` → expands suppressed markets inline.
- Tap `0.3u+` → opens the minimum-unit rule dimension.

**Watch mode**
- Rows are read-only. Progress bars and P/L animate on data push — interpolate width and cross-fade the number rather than snapping.
- Tape bar segments should re-proportion smoothly as games settle.

**Scores**
- Tap a condensed row → it becomes the expanded game and the previously expanded one collapses (accordion, one open).
- MINE / LIVE / ALL filters re-scope the list; MINE hides zero-position games entirely (the hollow pip only appears under ALL).

**Empty and error states are not designed.** At minimum specify: no plays today, model run failed (the header's `RUN 06:15 OK` becomes a failure state), odds feed stale (the health footer warning should surface as a header banner when it invalidates prices), and all positions settled.

**Responsive.** Designed at 390×844. On desktop (documented in the sheet, not mocked): the tape stays a fixed 520px left column, the right pane becomes game detail — all markets, model reasoning, line movement. The rule bar moves to a persistent left sidebar with league counts so it never scrolls away.

---

## State Management
Per-pick: `id`, `league`, `gameId`, `market` (ML/SPR/TOT), `selection`, `teamCode`, `price` (American), `units`, `tier` (5/7/10), `state` (`pass` | `take` | `fade`), `stateSource` (`rule` | `manual`), `locked`.

Per-game: `id`, `league`, `away`/`home` (code, name, color), `startsAt`, `live` (bool), `period`, `score`, `lineScore`, `situation`, `positions[]`.

Session: `tierThreshold`, `minUnit`, `mode` (`build` | `watch`), `leagueFilter`, `scoresFilter`, `expandedGameId`.

Derived (do not store): committed count and units, at-risk total, day P/L, tape bar proportions, pip clusters, per-segment pick counts.

Data needs: a morning model run (picks + tiers + units), a live odds feed (price staleness matters — the health panel tracks it), and a live scores/stats feed for watch and scores.

---

## Assets
- **Team logos are not included.** Every team mark in the prototypes is a monogram chip: a rounded square filled with the team's primary color, containing the 2–3 letter code in white Sans 700, plus a 1px inset white highlight at 14–16% opacity. Two sizes: **22px / 5px radius / 8px text** in market rows, **16px / 4px radius / 6px text** in game headers, condensed rows, and the results log. Real marks drop into the same slots with no layout change. Keep the chip as the fallback for leagues without clean assets — at 16px it carries team identity better than a shrunk logo. Over/under markets use a neutral `#2F3439` chip with `O` / `U`.
- **Tab bar icons are placeholders** (16px stroked squares). Supply real icons.
- **Fonts**: IBM Plex Sans + IBM Plex Mono, loaded from Google Fonts in the prototype. Bundle them in the app.
- Team colors used in the mocks are approximate primaries and should come from a real team-metadata table.

## Files
| File | What it is |
|---|---|
| `direction-a.html` | The design. Four phone frames plus token and trade-off notes. Open in a browser. |
| `sb.css` | Shared page scaffold and the phone/status-bar shell used by the frames. Presentation chrome only — not part of the app. |
| `direction-b.html`, `direction-c.html` | The two rejected directions, for context on what was considered and why A won. |
| `Shadow Bets.html` | The previous, fully interactive React prototype of the app. Superseded visually; useful for data shapes and prior behavior. |

Direction A is the chosen direction. B and C are reference only — do not mix their patterns in.
