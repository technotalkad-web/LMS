# Standalone xAPI (TinCan) packages — launch, tracking, resume

The LMS plays three package standards. This note covers the third one and
how it shares the cmi5 machinery.

| Standard | Descriptor | Runtime | Token hand-over |
| --- | --- | --- | --- |
| SCORM 1.2 | `imsmanifest.xml` | `window.API` shim in the parent page | none (server session) |
| cmi5 | `cmi5.xml` | package talks HTTP to `/api/xapi/*` | one-shot `fetch` URL → `{"auth-token": "Bearer …"}` |
| xAPI / TinCan | `tincan.xml` | package talks HTTP to `/api/xapi/*` | `auth` launch parameter, used verbatim |

Detection precedence when a zip carries more than one descriptor:
`cmi5.xml` → `imsmanifest.xml` → `tincan.xml`. A package that ships both
`imsmanifest.xml` and `tincan.xml` (some tools export both) still plays as
SCORM, so nothing changes for existing uploads. Migration `0076` admits
`manifest_type = 'xapi'` on `course_versions`.

## Launch URL

`/{org}/courses/{courseId}/launch` mints one attempt-bound token per launch
(`cmi5_launch_tokens`, same table as cmi5) and opens the launch file with the
standard TinCan parameters:

| Parameter | Value |
| --- | --- |
| `endpoint` | `https://<host>/api/xapi/` |
| `auth` | `Basic base64("lms:<token>")` — send it as the `Authorization` header, verbatim |
| `actor` | `{"objectType":"Agent","name":<email>,"account":{"homePage":<host>,"name":<userId>}}` |
| `activity_id` | the `<activity id>` from `tincan.xml` (also sent as `activityId` for engines that read the cmi5 name) |
| `registration` | the attempt id |

There is no `fetch` parameter. `authenticateXapi()` accepts the token in any
of the shapes players actually send: `Basic <base64>`, `Bearer <token>`, or
the bare token.

## What the LMS does with statements

Identical to cmi5 (`lib/xapi/process-statement.ts`):

- `completed` / `passed` / `failed` **about the launched activity id** decide
  completion, success and score. `completed_at` is set only then.
- Statements about sub-activities (`<activity_id>/<n>`, screens, questions)
  never complete the module. They feed **progress %** (screens done ÷ unit
  count) and per-question analytics.
- `terminated` closes the session but does not complete anything.

## Resume (State API)

`/api/xapi/activities/state?stateId=…` is keyed by **(attempt, stateId)**.
`activityId`, `agent` and `registration` are accepted and ignored. A relaunch
reuses the learner's open attempt, so the same registration and the same
saved state come back; the previous session's token stays valid until it
expires, so a tab left open keeps saving. `PUT` also raises progress from a
`{ current, completed: [...] }` blob (never lowers it, never completes).

Contract for content engines (KIVO included): **whenever the launch URL
carries `endpoint` + `auth`, read state on start and write it on every
navigation.** Do not gate the State API behind the cmi5 `fetch` handshake.
The package validator flags a build whose `cmi5PutState` / `cmi5GetState`
return early unless `cmi5LaunchActive` when it is uploaded as a tincan.xml
package ("Resume (xAPI saved state)" → warning).

## Validator checks specific to tincan.xml

- `activity-id` — fail when missing, warning when not an IRI.
- `activities` — info when several activities are declared.
- `mastery` — info: tincan.xml has no pass threshold; pass/fail is the package's own.
- `cmi5-resume`, `cmi5-outcome`, `cmi5-terminated`, `resume-setting` — same
  launch-file checks as cmi5.

## Tests

- `tests/bot/lifecycle/43-xapi-resume.spec.ts` — browser test (fixture
  package resumes at the saved slide after exit/relaunch; exit keeps
  In progress with 60 %; passed+completed finishes with score 90 and 100 %;
  a finished attempt is not resumed), API-level launch contract test, and a
  SCORM 1.2 regression test.
- Fixture: `tests/bot/fixtures/xapi.zip` (regenerate with
  `node tests/bot/fixtures/make-packages.mjs`).

Run against a dev server on the staging database after `0076` is applied:

```bash
E2E_BASE_URL=http://localhost:3000 npx playwright test --config=playwright.lifecycle.config.ts 43-xapi-resume
```
