# Scroll bar audit

Rule: any box with a bounded height or width whose content can exceed it scrolls on that axis and shows a bar that is drawn while the content overflows, not only on hover or while scrolling. Two mechanisms provide it:

- `scroll-visible` (utility in `artifacts/frontend/src/index.css`): `overflow: auto`, `scrollbar-gutter: stable`, `::-webkit-scrollbar` rules (Chromium, Safari; they opt out of macOS overlay bars) and, fenced to engines without that pseudo-element, `scrollbar-width: thin` plus `scrollbar-color` (Firefox). Track and thumb use the neutral tokens.
- `ScrollArea` (`components/ui/scroll-area.tsx`): Radix scroll area, now `type="auto"` (bar shown whenever the content overflows) instead of Radix's `hover`, with a horizontal bar added and the same neutral colours.

Where a permanent gutter would be wrong (popups, tables, dialogs, the collapsed rail: an empty track strip beside content that mostly does not overflow) the site uses `[scrollbar-gutter:auto]!`. The bar is still drawn whenever the content overflows. Lists and the main region keep the stable gutter.

Checked by `artifacts/frontend/e2e/scroll.spec.ts` (run with `pnpm --filter @workspace/frontend e2e`). In the page it visits every element, and for each one whose `scrollHeight > clientHeight` or `scrollWidth > clientWidth` and whose overflow is not `visible`, it requires overflow `auto` or `scroll`, the `scroll-visible` class (or a ScrollArea viewport with a bar), and room reserved for the drawn bar. It also requires that the document itself never scrolls. Ellipsis truncation and the rail's sideways clip (`data-clip-x="intended"`) are exempt. Playwright's headless Chromium hides all bars by default, so the config drops `--hide-scrollbars`.

## Sites in use

| Site | File | What overflows | Fix | Tested |
|---|---|---|---|---|
| Main content region | `components/AppShell.tsx` (`main`) | Every page taller than the window. It is the app's only vertical scroller. | `scroll-visible` (stable gutter) | every test |
| Rail panel | `components/AppShell.tsx` (`app-nav-panel`) | Recent jobs plus the foot controls on a short window | `scroll-visible [scrollbar-gutter:auto]!`; sideways clip kept on purpose | rail test |
| Results table (dashboard) | `pages/dashboard.tsx` via `ui/table.tsx` | Many vocabulary columns, horizontal | table wrapper is `scroll-visible` | demo job test |
| Other tables (jobs, flagged, benchmark runs, corpus metrics, per-row log, compare) | `pages/jobs.tsx`, `flagged.tsx`, `benchmark-runs.tsx`, `benchmark-results.tsx` via `ui/table.tsx` | Wide rows on narrow windows | same table wrapper | jobs, flagged, benchmark tests |
| Needs-review table | `pages/dashboard.tsx` via `ui/table.tsx` | Long review list, horizontal | same table wrapper | covered by the table wrapper |
| Vocabulary coverage list | `pages/dashboard.tsx` | `max-h-[200px]` list of vocabularies | `scroll-visible` | demo job test |
| Redundant `overflow-x-auto` around the results table | `pages/dashboard.tsx` | Never: the table wrapper inside already scrolls and clips | left as is (not scrollable in practice) | n/a |
| Name-column dropdown | `pages/upload.tsx`, `ui/select.tsx` | Wide files with many columns | Select viewport `scroll-visible`; see Select note | upload test |
| Entity-type dropdown | `pages/upload.tsx`, `ui/select.tsx` | 88+ Kestrel entity types (commit `9f821f8` capped it at `max-h-72`) | same | upload test |
| Vocabulary checkbox list | `pages/upload.tsx` | `max-h-64`, "Show all" lists 100+ prefixes | `scroll-visible` | upload test |
| Annotation mode and confidence filter dropdowns | `pages/upload.tsx`, `pages/dashboard.tsx`, `pages/benchmark.tsx` | Three options each, cannot overflow on a normal window; shorter than the window by construction | covered by the shared Select | results dropdown test |
| Benchmark filter dropdowns | `pages/benchmark-results.tsx` | One option per vocabulary (tens) | shared Select | benchmark test |
| Feedback dialog | `components/FeedbackDialog.tsx`, `ui/dialog.tsx` | Short windows | `DialogContent` caps at `100dvh - 2rem` and is `scroll-visible`; the page's own `overflow-y-auto` removed | feedback test |
| Delete dialogs | `pages/jobs.tsx`, `pages/benchmark-runs.tsx`, `ui/alert-dialog.tsx` | Short windows | `AlertDialogContent` caps at `100dvh - 2rem` and is `scroll-visible` | jobs test |
| Feedback textareas | `components/FeedbackDialog.tsx` | Long text | `scroll-visible [scrollbar-gutter:auto]!` | covered by the shared class |

## Select

Two things were wrong, both in `ui/select.tsx`:

1. Radix Select injects a rule that hides the scroll bar on its viewport (`scrollbar-width: none`, `::-webkit-scrollbar { display: none }`), so even a scrolling list drew no bar. `index.css` carries a higher-specificity override for `[data-radix-select-viewport].scroll-visible`.
2. `max-h-[--radix-select-content-available-height]` is Tailwind 3 shorthand and emits nothing in Tailwind 4, so the popup had no height cap and a long list ran off the bottom of the window with its lower options unreachable (this is why `9f821f8` needed a per-site `max-h-72`). It is now `max-h-(--radix-select-content-available-height)`. The same shorthand in `ui/context-menu.tsx` is fixed too. `ui/calendar.tsx` uses `h-[--cell-size]` the same way; it is unused and left alone.

## Shared primitives not used by any page today

Updated so they behave when first used, not exercised by tests: `ui/dropdown-menu.tsx` content, `ui/context-menu.tsx` content, `ui/command.tsx` list, `ui/sheet.tsx`, `ui/sidebar.tsx` content, `ui/textarea.tsx`, `ui/scroll-area.tsx` (no importer). `ui/menubar.tsx`, `ui/navigation-menu.tsx`, `ui/popover.tsx`, `ui/hover-card.tsx`, `ui/carousel.tsx`, `ui/drawer.tsx` and tooltips have no height-bounded scroll content and are unchanged.

## Not scroll sites

Chart boxes (`h-[180px]` in the dashboard) hold fixed-size SVG charts. Truncated table cells (`max-w-* truncate`) clip with an ellipsis and a `title`, which is intentional.

## Test hook

The dev auth bypass in `src/App.tsx` (`DevBypassApp`, development builds only) gained `/jobs` and the three `/benchmark` routes so the signed-in tests can reach those pages.
