# KIVO engine patch for ALDS step 0 — P2 and P3

Status: **PROPOSED, NOT APPLIED. Needs the owner's go before anyone edits KIVO.**
Blueprint: `docs/ambak-learning-data-standard/BLUEPRINT.md` §0, rows P2 and P3.

| Item | Defect today | Effect |
|---|---|---|
| P2a | Assessment true/false: `correctResponsesPattern` is inverted and `result.response` is empty | Every bank true/false question answered statement contradicts its own `result.success`; per-option analytics impossible |
| P2b | Assessment multi-select: `correctResponsesPattern` holds only the first correct option; `result.response` is malformed (`option_0,2,3`) | Multi-select statements fail the xAPI `choice` grammar |
| P3 | `contextActivities.category` = cmi5 is added to every statement in a cmi5 launch | `answered`, `experienced`, `progressed`, per-slide `completed/passed/failed` carry a category that cmi5 §7.1.3 forbids on non-defined statements (164/164 answered statements on staging). Full "allowed" conformance additionally needs the LMS session id from `LMS.LaunchData` (see "What P3 does NOT fix") |

## Where the code lives

* File (read-only for the LMS team): `D:/My Authoring Tool/In process/index.html`, inspected build:
  engine `ENGINE_VERSION = '2026.10.05.2'`, file dated 2026-10-05 19:55, sha256 prefix `bea7a9276ab928f0`.
* The engine is **not** a separate file. It is embedded base64 in `index.html` line 1036:
  `const __ENGINE_B64__ = "…"` (decoded by `loadEngineSource()`, line ~1045). Every edit below is made to the
  decoded engine and the result re-encoded into `__ENGINE_B64__` (or through the KIVO team's normal engine build, if
  they keep the engine source elsewhere). Line numbers below are in the decoded engine.
* Functions involved:
  * `asmtReportQuestion(slide, q, displayOrder, answerRec, attemptNumber)` — decoded line 9234. Builds a synthetic
    slide for each drawn bank question and calls `xapiAnswered()`.
  * `buildInteractionData(slide, response)` — line 11157. Already correct for `true-false` (`response.picked`
    boolean, `slide.correctAnswer` boolean) and `multi-response` (`response.selected` index array,
    `slide.correctAnswers` index array). Not changed.
  * `cmi5DecorateStatement(stmt)` — line 10857. Called by `xapiPostToLms()` (line 10986) for every statement in a
    cmi5 launch and by `cmi5SendInitialized()` (line 10802). Adds the category unconditionally.
  * `cmi5BuildContext(category)` — line 10786. Used by `cmi5SendProgress()` (line 10742, `progressed`),
    `cmi5SendCompleted()`, `cmi5SendInitialized()`, `cmi5SendTerminated()`.

### Root cause of P2

Bank questions are stored as `{ type: 'mcq'|'multi'|'truefalse'|'dropdown', options: [...], correct: [0-based indices] }`.
For `truefalse` the editor and the CSV import force `options = ['True', 'False']` (index 0 = True). Learner answers are
recorded as `answers[q.id].selected = [original option indices]` (`selectOption()`, line 9495; the shuffled display
order is mapped back through `data-oi`). `asmtReportQuestion` then:

* true/false: passes `correctAnswer: q.correct[0]` (an INDEX) to the `true-false` adapter, which reads it as a boolean
  (`slide.correctAnswer ? 'true' : 'false'`): index 0 (True) → `'false'`, index 1 (False) → `'true'` — inverted. It
  passes the response as `{ selected: idx }`, but the adapter reads `response.picked` → empty response.
* multi-select: maps `type: 'quiz'` (single choice) with `correctAnswer: q.correct[0]` → pattern with the first
  correct option only, and `{ selected: [0,2,3] }` into the single-choice adapter → `'option_' + [0,2,3]` =
  `option_0,2,3`.

## P2 patch — `asmtReportQuestion` (decoded engine line 9234)

Before:

```js
function asmtReportQuestion(slide, q, displayOrder, answerRec, attemptNumber) {
  // xAPI 'answered' per question
  try {
    if (typeof xapiAnswered === 'function') {
      const synth = {
        id: String(slide.id) + '_' + q.id,
        type: q.type === 'truefalse' ? 'true-false' : 'quiz',
        title: (slide.title || 'Assessment') + ' — Q' + (displayOrder + 1),
        question: q.text,
        options: q.options,
        correctAnswer: (q.correct || [])[0],
        correctAnswers: q.correct
      };
      const respShape = (q.type === 'multi')
        ? { selected: answerRec.selected }
        : { selected: (answerRec.selected || [])[0] };
      xapiAnswered(synth, respShape, !!answerRec.correct);
    }
  } catch (e) { console.warn('[Assessment] xAPI per-question failed:', e); }
}
```

After:

```js
function asmtReportQuestion(slide, q, displayOrder, answerRec, attemptNumber) {
  // xAPI 'answered' per question
  try {
    if (typeof xapiAnswered === 'function') {
      const isTF = q.type === 'truefalse';
      const isMulti = q.type === 'multi';
      const byIndex = (a, b) => a - b;
      // Original option indices (never display positions).
      const sel = (answerRec && Array.isArray(answerRec.selected)) ? answerRec.selected.slice().sort(byIndex) : [];
      const cor = Array.isArray(q.correct) ? q.correct.slice().sort(byIndex) : [];
      // True/False: read the option LABEL when it is recognisable; the editor
      // and CSV import always store ['True', 'False'], so fall back to
      // "index 0 means true" (a reordered or relabelled bank stays correct).
      const tfValue = (idx) => {
        if (idx == null) return null;
        const label = String((q.options || [])[idx] || '').trim().toLowerCase();
        if (label === 'true') return true;
        if (label === 'false') return false;
        return Number(idx) === 0;
      };
      const synth = {
        id: String(slide.id) + '_' + q.id,
        type: isTF ? 'true-false' : (isMulti ? 'multi-response' : 'quiz'),
        title: (slide.title || 'Assessment') + ' — Q' + (displayOrder + 1),
        question: q.text,
        options: q.options,
        // true-false adapter reads a BOOLEAN; quiz reads an index.
        correctAnswer: isTF ? tfValue(cor[0]) : cor[0],
        // multi-response adapter reads the FULL set of correct indices.
        correctAnswers: cor
      };
      const respShape = isMulti
        ? { selected: sel }                                     // → option_0[,]option_2[,]option_3
        : isTF
          ? { picked: sel.length ? tfValue(sel[0]) : null }     // → 'true' | 'false' | '' (unanswered)
          : { selected: sel.length ? sel[0] : null };           // → option_N | '' (unanswered)
      xapiAnswered(synth, respShape, !!answerRec.correct);
    }
  } catch (e) { console.warn('[Assessment] xAPI per-question failed:', e); }
}
```

Resulting statements (through the unchanged `buildInteractionData`):

| Question | `interactionType` | `correctResponsesPattern` | `result.response` |
|---|---|---|---|
| T/F, correct = True, learner picked False | `true-false` | `["true"]` | `"false"` |
| T/F, correct = False, learner picked False | `true-false` | `["false"]` | `"false"` |
| Multi, correct = options 0, 2, 3; learner picked 3, 0 | `choice` | `["option_0[,]option_2[,]option_3"]` | `"option_0[,]option_3"` |
| MCQ / dropdown (unchanged) | `choice` | `["option_N"]` | `"option_M"` |

The same adapters feed `scormReportInteraction()` (line ~12415), so SCORM interaction records for bank questions are
corrected by the same change (SCORM 2004: `true`/`false` and `option_0[,]option_2[,]option_3`; SCORM 1.2: `t`/`f` and
`option_0,option_2,option_3`); the SCORM interaction `type` becomes `true-false` / `choice` through
`scormInteractionType()` as before. `result.success` is unchanged (it already comes from `gradeAll()`). Unanswered
questions report an empty response, as today (`gradeAll()` always creates `answers[q.id]` with `selected: []`).

## P3 patch — `cmi5DecorateStatement` (decoded engine line 10857)

Rule (cmi5 §7.1.3 and §9.6.2, blueprint §1.3 and §5.2 G2): only **cmi5 defined** statements — a cmi5 verb whose
object is the AU itself (`stmt.object.id === xapiActivityId`) — carry the cmi5 category activity; `completed`, `passed`
and `failed` about the AU also carry the moveOn category. Every other statement is "cmi5 allowed" and MUST NOT carry
the cmi5 category. Because `xapiPostToLms()` routes every LMS statement of a cmi5 launch through this one function,
fixing it here covers `answered`, `experienced`, `progressed` (whose `cmi5BuildContext()` adds the category — it is
stripped here), per-slide and assessment-level `passed/failed/completed`, and the File Viewer `downloaded` statement.

Before (category block only; registration, sessionid and duration handling stay as they are):

```js
  // Category contextActivity. Pick the moveon category for outcome verbs;
  // otherwise the regular cmi5 category.
  const verbId = (stmt.verb && stmt.verb.id) || '';
  // moveon is reserved for AU-level outcome statements. Per-slide
  // completed/passed/failed (object = <activity>/<slideId>) are progress
  // only and must not look like the module's final outcome.
  const isAuLevel = !!(stmt.object && stmt.object.id === xapiActivityId);
  const isMoveon = isAuLevel && /\/(passed|failed|completed)$/i.test(verbId);
  const categoryId = isMoveon
    ? 'https://w3id.org/xapi/cmi5/context/categories/moveon'
    : 'https://w3id.org/xapi/cmi5/context/categories/cmi5';
  if (!stmt.context.contextActivities) stmt.context.contextActivities = {};
  if (!Array.isArray(stmt.context.contextActivities.category)) {
    stmt.context.contextActivities.category = [];
  }
  // Only add if not already present (idempotent — defensive against
  // double-decoration)
  const has = stmt.context.contextActivities.category.some(c => c && c.id === categoryId);
  if (!has) stmt.context.contextActivities.category.push({ id: categoryId });
```

After:

```js
  // Category contextActivity (cmi5 9.6.2). ONLY cmi5-defined statements —
  // a cmi5 verb about the AU itself — carry the cmi5 category; AU-level
  // completed/passed/failed also carry moveOn. Everything else (answered,
  // experienced, progressed, per-slide/assessment completed/passed/failed,
  // downloaded …) is "cmi5 allowed" and MUST NOT carry either category, so
  // any that a builder added (cmi5BuildContext) are stripped here.
  const CMI5_CAT = 'https://w3id.org/xapi/cmi5/context/categories/cmi5';
  const MOVEON_CAT = 'https://w3id.org/xapi/cmi5/context/categories/moveon';
  const verbId = (stmt.verb && stmt.verb.id) || '';
  const isAuLevel = !!(stmt.object && stmt.object.id === xapiActivityId);
  const isDefined = isAuLevel &&
    /\/(initialized|completed|passed|failed|terminated)$/i.test(verbId);
  const isMoveon = isDefined && /\/(passed|failed|completed)$/i.test(verbId);
  const ca = stmt.context.contextActivities || {};
  const kept = (Array.isArray(ca.category) ? ca.category : [])
    .filter(c => c && c.id !== CMI5_CAT && c.id !== MOVEON_CAT);
  if (isDefined) kept.push({ id: CMI5_CAT });
  if (isMoveon) kept.push({ id: MOVEON_CAT });
  if (kept.length) {
    ca.category = kept;
    stmt.context.contextActivities = ca;
  } else {
    delete ca.category;
    if (Object.keys(ca).length) stmt.context.contextActivities = ca;
    else delete stmt.context.contextActivities;
  }
```

Notes:
* `isDefined` lists the verbs an AU itself sends (cmi5 §9.3). `launched`, `abandoned`, `waived`, `satisfied` are
  LMS-only and never sent by KIVO.
* The "after" also adds the cmi5 category NEXT TO moveOn on AU-level `completed/passed/failed` (today they carry moveOn
  only). cmi5 §9.6.2.2 requires both on those statements; the LMS gateway's DEFINED classifier (blueprint §5.2 G2)
  keys on the cmi5 category. If the owner wants P3 to stay strictly "remove only", drop the line
  `if (isDefined) kept.push({ id: CMI5_CAT });` for outcome verbs — but the CATAPULT content suite (blueprint §9
  step 3) will then flag the outcome statements. CATAPULT also needs the companion change below for the Results
  slide's `passed`/`failed`.
* `cmi5SendProgress()` needs no change: its `cmi5BuildContext()` category is stripped by the decorator. (Optionally,
  for clarity, build its context without a category.)

### P3 companion change — AU-level `passed`/`failed` from the Results slide (`xapiSend`, decoded line ~11046)

With the decorator fixed, the Results slide's course-level `passed`/`failed` (object = `xapiActivityId`) is a
cmi5-defined statement, and today it breaks cmi5 rules: it carries `result.completion: true` (§9.5.3: defined
statements other than completed/waived MUST NOT include completion) and it has no `result.duration` (§9.5.4.1 —
verify the exact MUST/SHOULD wording against the current spec text; the LMS strict gateway, blueprint §5.2 G3 S2,
requires duration on completed/passed/failed/terminated). In strict mode the gateway would answer 400 — which KIVO
drops without retry, losing the module's pass/fail. Change the result block in
`xapiSend`:

Before:

```js
  if (extra && extra.score !== undefined) {
    stmt.result = {
      score: { scaled: extra.score / 100, raw: extra.score, min: 0, max: 100 },
      success: (extra.passed !== undefined ? !!extra.passed : extra.score >= coursePassingScore()),
      completion: true
    };
  }
```

After:

```js
  if (extra && extra.score !== undefined) {
    stmt.result = {
      score: { scaled: extra.score / 100, raw: extra.score, min: 0, max: 100 },
      success: (extra.passed !== undefined ? !!extra.passed : extra.score >= coursePassingScore())
    };
    if (isCourseLevel && typeof cmi5LaunchActive !== 'undefined' && cmi5LaunchActive) {
      // cmi5-defined passed/failed: no completion (§9.5.3); duration (§9.5.4.1, ALDS strict S2).
      const startedAt = (STATE && STATE.startTime) || Date.now();
      stmt.result.duration = cmi5FormatDuration(Math.max(0, (Date.now() - startedAt) / 1000));
    } else {
      stmt.result.completion = true;   // non-cmi5 launches and per-slide statements: unchanged
    }
  }
```

### What P3 does NOT fix on its own

§7.1.3 defines a "cmi5 allowed" statement as one that uses the cmi5 **context template** (registration, the LMS
session id, …). KIVO mints its own session id (`cmi5LaunchInit`: `cmi5SessionId = generateUuid()`) and never reads
`LMS.LaunchData`; the LMS does not serve `LMS.LaunchData` yet (blueprint §4 step 3, ALDS step 1). Until KIVO takes the
session id (and the rest of the context template) from `LMS.LaunchData` — blueprint §9 step 3 — the LMS gateway will
still classify `answered` statements as OTHER, not ALLOWED. P3 removes the category violation; it does not by itself
make them conformant.

## Verification after the re-export

1. Rebuild the engine (re-encode into `__ENGINE_B64__`) and bump `ENGINE_VERSION` (e.g. `2026.10.14.1`) so packages are
   identifiable; add a CHANGELOG entry. Apply the same rebuilt file to the HOSTED editor too:
   `In process/Cloudflare Deploy/index.html` is byte-identical to `In process/index.html` today (same sha256) and is
   what authors on the web editor export with — re-deploy it, or they keep exporting the old engine. Two older
   copies also embed an engine (`In process/deploy/index.html`, `In process/Module editor with game/index.html`);
   they look stale — do not export from them.
2. Re-export the staging test courses through the real editor pipeline:
   `node "LRS Development/perf-tools/build_pkg.js" index.html "<course>.elearning" out-cmi5.zip cmi5` (and `scorm`).
   Use a course with an Assessment slide whose bank has at least one true/false (correct = True), one true/false
   (correct = False) and one multi-select question with 3 correct options, AND a Results slide (only the Results
   slide emits the AU-level `passed`/`failed`; without one, `autoFireCourseCompletion` reports on the slide object).
3. Run the existing KIVO release checks: `static_validate.py <pkgDir>` and `e2e_runtime.js <finalDir>`, plus
   `assessment-resume-harness.js` and `cmi5-resume-harness.js`. **The cmi5 harness needs a matching edit**: TEST 7
   (`LRS Development/cmi5-resume-harness.js` ~line 205) dereferences
   `s.s.context.contextActivities.category.some(...)` on per-slide `completed`, which the P3 decorator now leaves
   without `contextActivities` → TypeError → "HARNESS ERROR". Change it to
   `((s.s.context.contextActivities || {}).category || []).some(...)` and add a check that per-slide statements carry
   NO cmi5 category and AU-level `initialized`/`terminated`/`completed` DO.
4. Upload the cmi5 package to a `qa-*` org on LMS staging, take the assessment once (answer the T/F questions one
   right, one wrong; the multi-select partially), then read the stored statements (service role, read-only):

   ```sql
   select raw->'verb'->>'id' as verb,
          raw->'object'->'definition'->>'interactionType' as itype,
          raw->'object'->'definition'->'correctResponsesPattern' as pattern,
          raw->'result'->>'response' as response,
          raw->'result'->>'success' as success,
          raw->'context'->'contextActivities'->'category' as category
     from public.xapi_statements
    where attempt_id = '<attempt id>'
    order by stored;
   ```

   Expected: T/F rows `pattern = ["true"]` or `["false"]` matching the question key, `response` `"true"`/`"false"`
   (never empty for an answered question) and consistent with `success`; multi-select `pattern` lists every correct
   `option_N` joined by `[,]`, `response` uses `[,]`; **`category` is null** on every `answered`, `experienced`,
   `progressed` and per-slide/assessment `completed/passed/failed` row; `initialized`/`terminated` on the AU carry the
   cmi5 category; AU-level `completed/passed/failed` carry moveOn (and cmi5, per the note above).
5. Optional: run the CATAPULT cmi5 content test suite against the package (blueprint §9 step 3 makes it a gate).

Historic data recorded before this patch keeps the defects; the LMS reads `result.success` only for legacy true/false
and multi-select rows (blueprint §8.1).
