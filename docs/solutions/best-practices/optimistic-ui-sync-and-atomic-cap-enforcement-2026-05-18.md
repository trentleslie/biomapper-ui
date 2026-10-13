---
title: "Optimistic UI sync with React Query and atomic database cap enforcement"
date: 2026-05-18
category: best-practices
module: biomapper-ui-flags
problem_type: best_practice
component: tooling
severity: high
applies_when:
  - Combining optimistic local state with TanStack Query background refetching
  - Enforcing server-side caps or constraints across concurrent requests
  - Any mutation where local state is derived from both user actions and server cache
tags:
  - react-query
  - optimistic-ui
  - tanstack-query
  - race-condition
  - sqlite
  - atomic-operations
  - toctou
  - cache-invalidation
---

# Optimistic UI sync with React Query and atomic database cap enforcement

## Context

When building persistent user-scoped metabolite flags (PR [#19](https://github.com/trentleslie/biomapper-ui/pull/19)), Greptile code review caught two race conditions that passed manual testing but would manifest in production:

1. **Stale refetch overwrites optimistic state** — a `useEffect` syncing API data to local state re-added deleted flags when a background refetch (e.g., window focus) fired during an in-flight DELETE mutation.
2. **Non-atomic cap enforcement** — separate `count_flags()` and `upsert_flag()` async calls allowed concurrent PUT requests near the 1000-flag cap to both pass the count check.

These patterns appear together frequently in any feature combining optimistic frontend updates with server-enforced constraints. (session history)

## Guidance

### Frontend: Synchronous cache write before guard release

Three rules for safe optimistic UI with React Query:

1. **Use `queryClient.setQueryData` in `onSuccess`** to synchronously patch the cache with the known post-mutation value before `isPending` flips to false.
2. **Guard the sync effect with `isMutating`** so stale refetch data cannot overwrite optimistic state while a mutation is in flight.
3. **Use replace semantics, not merge-only** when syncing server state to local state. Merge-only (add but never remove) makes deletions invisible.

```tsx
const isMutating = addMutation.isPending || removeMutation.isPending;

// Server → local sync, guarded
useEffect(() => {
  if (serverData && !isMutating) {
    setLocalState(new Set(serverData));
  }
}, [serverData, isMutating]);

// In mutation handler:
mutation.mutate(variables, {
  onSuccess: () => {
    // Synchronously update cache BEFORE isMutating flips to false
    queryClient.setQueryData<string[]>(queryKey, (old) =>
      computeExpectedPostMutationState(old, variables)
    );
    // Then trigger a background refetch for eventual consistency
    queryClient.invalidateQueries({ queryKey });
  },
  onError: () => {
    // Revert the optimistic local state change
    revertOptimisticUpdate();
  },
});
```

### Backend: Atomic check-and-act in a single statement

Never separate "read the constraint" from "perform the write" into two statements when concurrent requests can interleave.

```python
# --- BROKEN: check-then-act (TOCTOU race) ---
count = await db.count_items(user_id)
if count >= CAP:
    raise HTTPException(status_code=409)
await db.insert_item(user_id, item)  # two requests at count=999 both pass

# --- FIXED: single atomic statement with embedded guard ---
cursor = await conn.execute(
    """INSERT OR IGNORE INTO items (user_id, name, created_at)
       SELECT ?, ?, ?
       WHERE (SELECT COUNT(*) FROM items WHERE user_id = ?) < ?""",
    (user_id, name, now, user_id, CAP),
)
await conn.commit()
inserted = cursor.rowcount > 0
```

The `INSERT ... SELECT ... WHERE (subquery) < cap` pattern collapses the read and write into one statement. Under SQLite's serialized writes, this is atomic.

## Why This Matters

**Stale refetch overwrites** are subtle because they only manifest under specific timing: a background refetch must land between the optimistic update and the mutation settlement. This passes manual testing (where refetches rarely coincide) but appears in production under window-focus refetch, fast tab-switching, or network latency variation. Users see a deleted item reappear momentarily — an unsettling "undo itself" behavior.

**Non-atomic cap enforcement** is a classic TOCTOU (time-of-check-to-time-of-use) vulnerability. Under normal load it is invisible. Under concurrent requests (double-click, parallel browser tabs) it allows the constraint to be violated silently.

Both bugs were caught by Greptile code review, not during development or testing — highlighting why automated review is valuable for concurrency issues. (session history)

## When to Apply

- Any feature combining **optimistic UI updates** with **TanStack Query / SWR background refetching**
- Any mutation where local state is derived from both user actions and server cache
- Any server-side constraint (caps, uniqueness, quotas) enforced across concurrent requests
- Especially relevant when `refetchOnWindowFocus` is enabled (TanStack Query default)

## Examples

### The three-stage failure progression (diagnostic checklist)

| Stage | Sync Logic | Failure Mode |
|-------|-----------|--------------|
| Merge-only | `merged.add(item)` never deletes | Deletions silently revert on any refetch |
| Replace without cache patch | `setState(new Set(serverData))` + `isMutating` guard | Stale cache value flows through in the render where `isPending` flips false |
| Replace with synchronous cache patch | `setQueryData` in `onSuccess` before guard releases | Correct — cache is consistent before local state syncs |

This progression was the actual debugging path during the flags implementation. The first fix (merge → replace + guard, commit `af3c6cd`) was insufficient — a second Greptile comment caught the `isPending` timing issue, requiring the `setQueryData` fix (commit `70cb656`). (session history)

### Actual implementation (metabolite flags)

Frontend (`dashboard.tsx`):
```tsx
const createFlagMutation = useCreateFlag();
const deleteFlagMutation = useDeleteFlag();
const isMutating = createFlagMutation.isPending || deleteFlagMutation.isPending;

useEffect(() => {
  if (persistedFlags && !isDemo && !isMutating) {
    setFlaggedNames(new Set(persistedFlags));
  }
}, [persistedFlags, isDemo, isMutating]);

const flagReviewItem = (name: string) => {
  const wasFlagged = flaggedNames.has(name);
  // Optimistic update
  setFlaggedNames(prev => {
    const next = new Set(prev);
    if (wasFlagged) next.delete(name); else next.add(name);
    return next;
  });
  if (!isDemo) {
    const mutation = wasFlagged ? deleteFlagMutation : createFlagMutation;
    mutation.mutate(
      { params: { name } },
      {
        onSuccess: () => {
          queryClient.setQueryData<string[]>(getListFlagsQueryKey(), (old = []) =>
            wasFlagged ? old.filter((n) => n !== name) : [...old, name]
          );
          queryClient.invalidateQueries({ queryKey: getListFlagsQueryKey() });
        },
        onError: () => {
          setFlaggedNames(prev => {
            const reverted = new Set(prev);
            if (wasFlagged) reverted.add(name); else reverted.delete(name);
            return reverted;
          });
          toast({ variant: "destructive", title: "Failed to update flag" });
        },
      },
    );
  }
};
```

Backend (`database.py`):
```python
async def upsert_flag(self, user_id: str, name: str, cap: int = 1000) -> bool:
    cursor = await self._conn.execute(
        """INSERT OR IGNORE INTO flagged_names (user_id, name, created_at)
           SELECT ?, ?, ?
           WHERE (SELECT COUNT(*) FROM flagged_names WHERE user_id = ?) < ?""",
        (user_id, name, time.time(), user_id, cap),
    )
    await self._conn.commit()
    if cursor.rowcount > 0:
        return True
    # rowcount=0 means EITHER cap reached OR name already exists (OR IGNORE).
    # Distinguish by checking existence — safe because the constraint was
    # already enforced atomically above.
    check = await self._conn.execute(
        "SELECT 1 FROM flagged_names WHERE user_id = ? AND name = ?",
        (user_id, name),
    )
    return (await check.fetchone()) is not None
```

## Related

- **Origin plan:** [persistent-user-flags-plan.md](../../plans/2026-05-17-003-feat-persistent-user-flags-plan.md)
- **PR:** [trentleslie/biomapper-ui#19](https://github.com/trentleslie/biomapper-ui/pull/19)
- **Greptile review comments:** P1 stale refetch, P1 optimistic revert timing, P2 non-atomic cap
- **Related race condition in codebase:** IndexedDB write vs navigation timing in upload flow (different layer, same async timing class)
