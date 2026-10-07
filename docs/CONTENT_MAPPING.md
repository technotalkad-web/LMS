# Business Vertical → Department master data and content mapping (Phase 4b)

Approved addendum "Manager Rights and Content Scope" (2026-10-07), decisions
16–20. Migration `0096_department_content_mapping.sql`.

## Department master data

- `org_field_options` gains the field `department`. A department hangs under
  a Business Vertical (`parent_id` → the vertical's own option row), so the
  same name can exist under two verticals. Unique per (org, vertical,
  value) for departments; per (org, field, value) for everything else.
- Master data page (Super Owner): the Department section lists departments
  grouped by vertical; add one by picking the vertical first.
  `POST /api/org-field-options { field: "department", value, parent_id }`.
- `organization_members.department` is governed like Branch: once the org
  has department values the field is restricted to them and **must belong
  to the member's own vertical** (`checkDepartmentInVertical`); it is never
  mandatory (decision 17). A vertical change on the edit form clears the
  department; a vertical change that orphans a stored department (edit API,
  bulk CSV, CRM sync) clears it too (the CRM response carries a warning).
- Everywhere the member fields flow: user create/edit forms (the Department
  select follows the chosen vertical), bulk CSV (`department` column,
  appended last; absent column preserves, empty cell is ignored like
  vertical/branch), CRM employee sync (`department` in and out), profile.
- Dynamic Custom Groups gain a `departments` rule; journey audiences gain
  `departments` (TypeScript sync and the SQL auto-enrol trigger).
- `LearnerInsight.department` is carried for the Phase 4c visibility rule.

## Content mapping ("Belongs to")

- `content_scopes`: one row per (content_type course|path|journey,
  content_id, vertical, department). `department null` = the whole vertical;
  `vertical '*'` = common to all verticals (decision 16). Mapping is **not**
  visibility: nothing is assigned, enrolled or unlocked by it (decision 15).
- `lib/content/scopes.ts`: `loadScopes`, `checkScopes` (master-data
  validation, canonical spellings), `saveScopes` (replace-all), `scopesCover`
  (decision 20).
- `PUT /api/content-scopes { orgSlug, items: [{type,id}], scopes: { common,
  pairs } }` — admin only; content must belong to the org. `GET` reads one.
- `ScopePicker` (`app/[org]/(admin)/_components/scope-picker.tsx`) sits on the
  course details page, each learning path's edit panel and the journey
  Settings tab; the **Content mapping** review page
  (`/[org]/master-data/content-mapping`, admins) lists every item, filters
  to Unmapped and maps in bulk. The Master data page shows the unmapped count.
- The CRM catalog returns `scopes: [{ vertical, department }]` and
  `common_to_all` per item.

## Assign to a Vertical / Department (decision 18)

- Built on dynamic Custom Groups: one system-managed group per pair
  (`org_groups.system_key = scope:<vertical>|<department>`, rules
  `{ verticals: [v], departments: [d] }`), created on first use
  (`lib/org/scope-groups.ts ensureScopeGroup`). Every assignment expander
  (Report Card insights, CRM progress, course access, reminders) already
  resolves dynamic groups live, so nothing downstream changes.
- `POST /api/assignments` and `/api/learning-path-assignments` accept
  `scopes: [{ vertical, department? }]` (validated against master data) and
  turn each into a group assignment. The assign screens have a "Vertical /
  Department" picker. Journeys use their audience (`departments`) + Sync.
- System groups show a **System** badge in Custom Groups; the API refuses
  to rename, re-rule or delete them (409). Deactivating is allowed; the
  next vertical assignment re-activates. Renaming a master value does not
  rewrite system group rules (documented limit).

## Warn, never block (decision 20)

Both assignment routes return `warnings[]` when the content's mapping does
not cover the target: a vertical / department target outside the mapping,
or named people whose vertical + department is outside it. The assign
screens show the warning; the assignment still happens. Unmapped and
common-to-all content never warns.

## Deploy order

Apply `0096_department_content_mapping.sql` on staging before merging and on
prod before tagging. Before 0096: the Department section says departments
need the migration, content mapping answers "not enabled yet", scope
pickers read as unmapped, and assignments to a vertical fail with the same
message. Nothing else changes behaviour.

## Tests

- `npx tsx tests/unit/content-mapping.test.ts` — department ⊂ vertical,
  `checkScopes`, `scopesCover`, scope-group keys/names, group rules with
  departments (no DB).
- Staging harness `node_modules/.qa/check-content-mapping.mjs` (dev
  session): master data departments, employee department paths (API, bulk
  CSV, CRM), content mapping API + review page, assign to vertical /
  department (system group, reach, warnings, system-group guard), journey
  audience departments.
