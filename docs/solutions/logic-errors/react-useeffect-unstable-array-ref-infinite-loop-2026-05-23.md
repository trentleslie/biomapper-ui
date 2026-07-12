---
title: "React useEffect infinite re-render from unstable ?? [] fallback"
date: 2026-05-23
category: logic-errors
module: upload-page
problem_type: logic_error
component: tooling
symptoms:
  - "Infinite re-render loop while TanStack Query data is loading"
  - "useEffect fires continuously until query resolves"
  - "setState called on every render creating new object references"
root_cause: logic_error
resolution_type: code_fix
severity: high
tags:
  - react
  - useeffect
  - tanstack-query
  - infinite-loop
  - nullish-coalescing
  - dependency-array
---

# React useEffect infinite re-render from unstable ?? [] fallback

## Problem

Replacing a hardcoded constant with an API-driven lookup introduced an infinite re-render loop. The `useEffect` that swaps vocabulary presets on entity type change would fire continuously while the TanStack Query was loading, creating a render storm until the query resolved.

## Symptoms

- Infinite re-render loop on page load while entity types query is in flight
- `setSelectedVocabPrefixes(new Set([]))` called on every render
- React dev tools show continuous re-renders on the upload page

## What Didn't Work

- Using `entityTypesQuery.data ?? []` as a derived local variable and putting that variable in the `useEffect` dependency array. This was the initial implementation — it compiled without errors and appeared correct, but the `[]` literal creates a new array reference on every render when `data` is `undefined`.

## Solution

Use `entityTypesQuery.data` directly in the dependency array instead of a derived variable with a fallback:

**Before (broken):**
```tsx
const entityTypes = entityTypesQuery.data ?? [];
useEffect(() => {
  const matched = entityTypes.find(et => et.type === entityType);
  const preset = matched?.defaultPrefixes ?? [];
  setSelectedVocabPrefixes(new Set(preset));
}, [entityType, entityTypes]); // entityTypes is new [] on every render when data is undefined
```

**After (fixed):**
```tsx
const entityTypes = entityTypesQuery.data ?? [];
useEffect(() => {
  const matched = entityTypesQuery.data?.find(et => et.type === entityType);
  const preset = matched?.defaultPrefixes ?? [];
  setSelectedVocabPrefixes(new Set(preset));
}, [entityType, entityTypesQuery.data]); // stable reference from TanStack Query
```

The `entityTypes` variable with `?? []` is still used for rendering (dropdown, vocab filtering) where a new array on each render is harmless. But the dependency array must use the stable query `.data` reference.

## Why This Works

`entityTypesQuery.data` is a stable reference managed by TanStack Query — it's `undefined` while loading and then a stable array reference once resolved. React's dependency comparison sees the same `undefined` across renders and doesn't re-fire the effect.

The `?? []` fallback creates a **new** empty array literal on every render cycle. Since `[] !== []` in JavaScript (reference equality), React treats it as a changed dependency and fires the effect. The effect calls `setState`, which triggers a re-render, which creates another new `[]`, which fires the effect again — infinite loop.

## Prevention

- When using query data in `useEffect` dependency arrays, always use the query's `.data` property directly, never a derived variable with a fallback
- Use `?? []` only in rendering code where new references are harmless (`.map()`, `.find()`, `.length`)
- ESLint's `react-hooks/exhaustive-deps` rule catches missing deps but does NOT catch unstable references — this class of bug requires manual review

## Related Issues

- [PR #20](https://github.com/trentleslie/biomapper-ui/pull/20) — feat: consume dynamic vocabulary presets from entity types API
