# Reporting lines (Employee → L1 → L2 → L3)

Migration `0091_reporting_lines_l3.sql`. Product decisions 2, 3, 7, 8, 9 of the
Manager Report Card plan (2026-10-06).

## The rule

The hierarchy is **explicit, never inferred**. Every `organization_members`
row carries three manager fields:

| Level | Column                | Meaning                          |
|-------|-----------------------|----------------------------------|
| L1    | `line_manager_id`     | direct manager                   |
| L2    | `indirect_manager_id` | the L1 manager's manager         |
| L3    | `l3_manager_id`       | the L2 manager's manager (0091)  |

**Visibility** (`lib/org/reporting-line.ts` → `resolveManagerScope`): a
manager sees exactly the people who list them as L1, L2 or L3 — direct ∪
via-L2 ∪ via-L3 — and nobody else. Their *level* is the highest level anyone
assigns them (L3 if anyone names them as L3, else L2, else L1, else not a
manager). Only active members are in scope; the viewer is never in their own
scope. A blank L2/L3 means "not visible at that level" — there is no fallback
to the L1 chain.

The Report Card (Phase 1+) consumes this resolver; nothing else decides scope.

## Integrity (decision 9)

Every write path runs `validateManagerAssignment` with the org snapshot:

| Blocks the save                                        | Warns (saved, returned as `warnings`) |
|--------------------------------------------------------|---------------------------------------|
| manager = the person themselves                        | L2 ≠ the L1 manager's own manager     |
| manager is not a member / is inactive or suspended     | L3 ≠ the L2 manager's own manager     |
| the manager already reports up to this person (a cycle through ANY of the three edges) | |

A blank level is never a save-time warning (a top-level manager has none);
`checkIntegrity` reports blank levels under Master data → Reporting lines →
"Worth a look", alongside the org-wide view of everything above.

Write paths: `POST /api/users`, `PATCH /api/users/[id]` (the edit form only
sends manager fields the admin changed, so an old pointer at someone who has
left never fails an unrelated edit), `POST /api/users/bulk` (row skipped;
warnings in the row message), `PUT /api/integrations/employees` (the offending
field is **dropped + warned**; the sync never fails on an unresolvable or
invalid manager reference on UPDATE, nor on CREATE while the org does not
require managers — with the toggle on, a blank/unresolvable L1/L2/L3 at create
is a `400`), `PATCH /api/reporting-lines`.

`organizations.require_manager_fields` (Master data toggle) now means **L1 +
L2 + L3 are mandatory** at create (decision 8) — forms, bulk CSV and CRM sync.
Manager pickers in the user forms list active members only.

## Master data → Reporting lines

`/{org}/master-data/reporting-lines` (Super Owner), API `/api/reporting-lines`:

- **Must fix** — blocking issues from `checkIntegrity` across the org.
- **Backfill** (decision 7) — `suggestBackfill`: empty L2 → the L1 manager's
  L1; empty L3 → the (existing or suggested) L2 manager's L1. Suggestions only;
  the admin confirms ("apply all" or per row). The API re-derives the
  suggestions before writing, so a stale or hand-crafted apply list is skipped.
- **Look up a person** — their L1/L2/L3 (editable) and who reports to them at
  each level.
- **Worth a look** — warnings grouped by kind.

## Bulk CSV / CRM

- CSV columns `line_manager_id`, `indirect_manager_id`, `l3_manager_id`
  (appended last — positional header-less files keep their meaning) take an
  email or user id. Rows are processed **managers first**: a manager
  referenced by email that is itself a row of the file is written before the
  rows that point at them, whatever the file order (so a new manager and
  their team can arrive in one file). A manager column that is **absent**
  from the file leaves that level untouched — re-running an older export
  never wipes L3s set since, and an existing member's already-set L3
  satisfies the mandatory rule; a present-but-empty cell clears it.
- CRM: `line_manager_employee_id` / `indirect_manager_employee_id` /
  `l3_manager_employee_id`; `GET` echoes all three as employee_ids.
- Backfill writes are grouped (one `UPDATE … IN (…)` per distinct L2/L3
  pair, ≤500 ids each) and the page sends them in chunks, so "apply all"
  works for any org size.

## Deploy order

Apply `0091` on **staging before merging to main** (staging auto-deploys from
main) and on **prod before tagging**. The app selects and writes
`l3_manager_id` unconditionally: until the column exists, user create/edit,
bulk upload, the CRM employee sync and the Reporting lines page fail.

## Tests

- `npx tsx tests/unit/reporting-line.test.ts` — scope, integrity (incl.
  cycles through L2/L3 edges), backfill, validation (no DB).
