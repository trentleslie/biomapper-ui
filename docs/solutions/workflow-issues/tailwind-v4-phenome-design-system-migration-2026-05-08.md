---
title: "Migrating Phenome Design System to Tailwind v4 + shadcn/ui"
date: 2026-05-08
category: workflow-issues
module: frontend
problem_type: workflow_issue
component: tooling
severity: medium
applies_when:
  - Applying a design system spec written for Tailwind v3 to a Tailwind v4 project
  - Restyling shadcn/ui components to match a custom brand or design system
  - Removing dark mode from a shadcn/ui setup
  - Reviewing PRs that touch @theme blocks or shadcn component variants
tags:
  - tailwind-v4
  - design-system
  - shadcn-ui
  - css-variables
  - phenome-health
  - react
  - tokens
---

# Migrating Phenome Design System to Tailwind v4 + shadcn/ui

## Context

The Biomapper UI frontend (React 18 + Vite + Tailwind v4.2.1 + shadcn/ui) needed to conform to the Phenome Health design system. The design system spec (`phenome-web-design-system.md`) was written for Tailwind v3 and provided a `tailwind.config.js` with theme extensions. The project runs Tailwind v4, which has no `tailwind.config.js` — all token configuration goes in CSS `@theme` blocks. Additionally, the shadcn/ui components had been customized with Replit-specific patterns (HSL CSS variable indirection, `hover-elevate` classes, dark mode support) that conflicted with the design system's requirements.

The migration touched 28 files (+404/-377 lines) across 7 commits and was executed with parallel subagents for independent units.

## Guidance

### Token Migration: Tailwind v3 config to v4 @theme

**Drop `hsl()` wrappers entirely.** The existing shadcn/ui theme used `hsl(var(--primary))` indirection in the `@theme inline` block with HSL triplets in `:root`. Tailwind v4's `@theme` expects raw values. Assign hex values directly:

```css
/* Correct — v4 @theme */
@theme inline {
  --color-primary: #113682;
  --color-ph-navy: #113682;
  --color-neutral-200: #E3E7EE;
}

/* Wrong — v3 pattern that produces hsl(#113682) = invalid CSS */
@theme inline {
  --color-primary: hsl(var(--primary));  /* breaks */
}
```

**Use explicit radius values, not `calc()`.** The v3 pattern `--radius-sm: calc(var(--radius) - 4px)` breaks in v4. If `--radius` is set to 4px, `--radius-sm` becomes 0px, collapsing borders on components like SelectItem:

```css
/* Correct */
--radius-sm: 2px;
--radius: 4px;
--radius-md: 6px;
--radius-lg: 8px;

/* Wrong — cascading calc produces unexpected values */
--radius-sm: calc(var(--radius) - 4px);  /* = 0px when --radius is 4px */
```

**Define hover/active color variants as named tokens.** Never use arbitrary hex brackets for state colors — they bypass the token layer and silently diverge when brand colors change (caught by Greptile review as P2):

```css
@theme inline {
  --color-ph-navy: #113682;
  --color-ph-navy-dark: #0d2a68;    /* hover */
  --color-ph-navy-darker: #0a1f4f;  /* active */
}
```

```tsx
// Correct — named token
"bg-ph-navy hover:bg-ph-navy-dark active:bg-ph-navy-darker"

// Wrong — arbitrary hex, invisible to auditing
"bg-ph-navy hover:bg-[#0d2a68] active:bg-[#0a1f4f]"
```

### Component Restyling Strategy

**Restyle shadcn/ui in place — do not replace.** When 50+ primitives are wired into the app, replacing them with inline design-system recipes is a massive, error-prone rewrite. Instead, edit the shadcn component files to use new tokens while preserving the component API (props, exports, forwardRef).

**Keep variant names stable for backward compatibility.** The `outline` button variant was used in 15+ places including shadcn internals (carousel, pagination, alert-dialog). Renaming it would break those components. Instead, keep the name but restyle its output to match the design system's `secondary` visuals.

**Add backward-compatibility aliases for badges.** Map old shadcn variant names to new design-system tones so existing call sites don't break:

```tsx
variants: {
  variant: {
    // New tone-based variants
    neutral: "bg-neutral-100 text-neutral-700 border-neutral-200",
    success: "bg-success-bg text-success border-success-border",
    warning: "bg-warning-bg text-warning border-warning-border",
    danger:  "bg-danger-bg text-danger border-danger-border",
    // Backward-compat aliases (same styling, old names)
    outline:     "bg-neutral-100 text-neutral-700 border-neutral-200",
    secondary:   "bg-neutral-100 text-neutral-700 border-neutral-200",
    destructive: "bg-danger-bg text-danger border-danger-border",
  }
}
```

**Replace inline style patterns with variant props.** The dashboard used `style={{ color: TIER_COLORS[tier], borderColor: 'currentColor' }}` on badges, bypassing the variant system entirely. These must be replaced with tone-based variant props (high→success, medium→warning, low→danger, unknown→neutral) or the badge restyling has no visible effect on the most prominent usage.

### Focus Ring Consistency

**Use `focus-visible:` not `focus:` on form inputs.** The global focus ring rule uses `:focus-visible`. If inputs use `focus:ring-*`, both pseudo-classes fire on keyboard focus, creating a specificity fight. Standardize on `focus-visible:` everywhere. Inputs can override the global `ring-2` with `focus-visible:ring-1` — the utility layer takes precedence over `@layer base`. (Session history: this inconsistency was caught during planning review pass 2.)

**Use `ring-offset-background` not `ring-offset-white`.** Components on non-white surfaces (sidebar `bg-neutral-50`, badge backgrounds) show a visible white gap artifact when `ring-offset-white` is hardcoded. Using `ring-offset-background` inherits from the semantic `--background` variable. (Caught by Greptile review as P2.)

### Dark Mode Removal

When the design system is light-only, dark mode removal is a four-step sweep:
1. Remove `.dark {}` block and `@custom-variant dark` from `index.css`
2. Grep for `dark:` across all `.tsx` and `.css` files — remove the **entire** `dark:*` class token (not just the prefix)
3. Check for `.dark` string constants (e.g., `chart.tsx` has `const THEMES = { light: '', dark: '.dark' }`)
4. Update `sonner.tsx` to hardcode `theme="light"` and remove `next-themes` import/dependency

Also remove Replit-specific custom properties (`--elevate-1`, `--elevate-2`, `--opaque-button-border-intensity`) that have no CSS consumers after the restyling.

### Semantic Color Gotcha: `bg-success` vs `variant="success"`

Using `bg-success` as a background class applies the raw success token (`#005B33`, dark green) — with dark text inherited from the default badge variant, this produces near-invisible dark-on-dark contrast. Use `variant="success"` instead, which applies the light `bg-success-bg` (`#E6F2EC`) with dark `text-success` text. This applies to all semantic colors: always use the tone variant, not the raw `bg-{semantic}` class, for badges and alerts. (Caught by Greptile review as P1.)

## Why This Matters

- **Tailwind v3→v4 format differences cause silent failures**: colors render transparent, radii collapse to 0, fonts fall back to system defaults. These are not compile errors — they only appear visually.
- **Arbitrary hex in utilities** defeats the purpose of a design system. They can't be audited with grep for `--color-*` and diverge silently when tokens are updated.
- **Leftover dark mode artifacts** cause specificity conflicts and unused CSS bloat.
- **Badge contrast failures** are accessibility regressions — text becomes unreadable for all users, not just those with visual impairments.
- **Ring offset mismatches** produce a visible "halo" artifact around focused elements on colored backgrounds.

## When to Apply

- Migrating any Tailwind v3 design system spec to a Tailwind v4 project
- Restyling shadcn/ui components to match a custom brand or organizational design system
- Removing dark mode from a previously dark-mode-capable shadcn/ui setup
- Reviewing PRs that touch `@theme` blocks, shadcn component variant definitions, or focus ring styles
- Building a shared AppShell layout wrapping authenticated pages

## Examples

**Full @theme block structure (Phenome tokens in Tailwind v4):**

```css
@theme inline {
  /* Brand + hover variants */
  --color-ph-navy: #113682;
  --color-ph-navy-dark: #0d2a68;
  --color-ph-navy-darker: #0a1f4f;

  /* Semantic state colors with bg/border variants */
  --color-success: #005B33;
  --color-success-bg: #E6F2EC;
  --color-success-border: #B8D9C7;

  /* Explicit radius values */
  --radius-sm: 2px;
  --radius: 4px;
  --radius-md: 6px;

  /* Shadows */
  --shadow-xs: 0 1px 2px 0 rgba(11, 21, 45, 0.04);
}
```

**Global focus ring with adaptive offset:**

```css
@layer base {
  :focus-visible {
    @apply outline-none ring-2 ring-ph-navy ring-offset-2 ring-offset-background;
  }
}
```

**Execution order for parallel safety (non-overlapping file sets):**

```
Unit 1 (tokens/CSS) ──→ Units 2-7 (components, parallel) ──→ Units 8-9 (pages, parallel) ──→ Unit 10 (cleanup)
```

## Related

- **Design system source:** `phenome-web-design-system.md` (loaded via `/phenome-ui` skill)
- **Plan:** `docs/plans/2026-05-08-001-feat-phenome-ui-overhaul-plan.md`
- **PR:** trentleslie/biomapper-ui#11
- **Branch workflow:** feature→dev (Greptile review) then dev→main (production deploy) (auto memory [claude])
