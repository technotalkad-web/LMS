/**
 * Generates valid synthetic course packages for the lifecycle bot:
 *   - scorm12.zip  (SCORM 1.2, masteryscore 80, uses window.API)
 *   - cmi5.zip     (cmi5 AU that emits xAPI statements to the launch endpoint)
 *
 * These are intentionally tiny but spec-valid: the manifest parsers
 * (lib/courses/manifest/*) accept them and the runtimes can drive them in a
 * real browser. For deterministic journey states we ALSO drive tracking via the
 * commit / xAPI endpoints directly — these zips just exercise upload + launch.
 *
 * Run: node tests/bot/fixtures/make-packages.mjs
 */
import JSZip from "jszip";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

// ---------- SCORM 1.2 ----------
const scormManifest = `<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="qa.scorm12.bot" version="1.0"
  xmlns="http://www.imsproject.org/xsd/imscp_rootv1p1p2"
  xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <metadata>
    <schema>ADL SCORM</schema>
    <schemaversion>1.2</schemaversion>
  </metadata>
  <organizations default="ORG-1">
    <organization identifier="ORG-1">
      <title>QA Bot SCORM 1.2 Course</title>
      <item identifier="ITEM-1" identifierref="RES-1">
        <title>Module 1</title>
        <adlcp:masteryscore>80</adlcp:masteryscore>
      </item>
    </organization>
  </organizations>
  <resources>
    <resource identifier="RES-1" type="webcontent" adlcp:scormtype="sco" href="index.html">
      <file href="index.html"/>
    </resource>
  </resources>
</manifest>`;

const scormHtml = `<!doctype html><html><head><meta charset="utf-8"><title>QA SCORM 1.2</title></head>
<body>
<h1>QA Bot SCORM 1.2 Course</h1>
<p id="status">starting…</p>
<button id="pass">Mark passed (90)</button>
<button id="fail">Mark failed (40)</button>
<script>
  // Walk up to find the SCORM 1.2 API the LMS injects on the parent window.
  function findAPI(w){ let n=0; while(w && !w.API && w.parent && w.parent!==w && n++<10) w=w.parent; return w && w.API; }
  var API = findAPI(window);
  var s = document.getElementById('status');
  if (!API) { s.textContent = 'ERROR: window.API (SCORM 1.2) not found'; }
  else {
    API.LMSInitialize('');
    s.textContent = 'initialized';
    function finish(score, status){
      API.LMSSetValue('cmi.core.score.raw', String(score));
      API.LMSSetValue('cmi.core.lesson_status', status);
      API.LMSCommit('');
      API.LMSFinish('');
      s.textContent = 'committed ' + status + ' (' + score + ')';
    }
    document.getElementById('pass').onclick = function(){ finish(90, 'passed'); };
    document.getElementById('fail').onclick = function(){ finish(40, 'failed'); };
  }
</script>
</body></html>`;

// ---------- cmi5 ----------
const cmi5Xml = `<?xml version="1.0" encoding="UTF-8"?>
<courseStructure xmlns="https://w3id.org/xapi/profiles/cmi5/v1/CourseStructure.xsd">
  <course id="https://qa.bot/cmi5/course">
    <title><langstring lang="en">QA Bot cmi5 Course</langstring></title>
    <description><langstring lang="en">Synthetic cmi5 package for lifecycle testing.</langstring></description>
  </course>
  <au id="https://qa.bot/cmi5/au1" masteryScore="0.8" moveOn="CompletedOrPassed">
    <title><langstring lang="en">AU 1</langstring></title>
    <description><langstring lang="en">Single assignable unit.</langstring></description>
    <url>index.html</url>
  </au>
</courseStructure>`;

const cmi5Html = `<!doctype html><html><head><meta charset="utf-8"><title>QA cmi5</title></head>
<body>
<h1>QA Bot cmi5 Course</h1>
<p id="status">starting…</p>
<button id="pass">Send passed (0.9)</button>
<script>
  // cmi5 AU: read launch params, exchange fetch token for an auth token,
  // then POST xAPI statements to the LMS LRS endpoints.
  var q = new URLSearchParams(location.search);
  var endpoint = q.get('endpoint');       // e.g. https://host/api/xapi/
  var fetchUrl = q.get('fetch');          // one-shot token exchange
  var actor = JSON.parse(q.get('actor') || '{}');
  var registration = q.get('registration');
  var activityId = q.get('activityId');
  var s = document.getElementById('status');

  async function auth(){
    var r = await fetch(fetchUrl, { method:'POST' });
    var j = await r.json();
    return j['auth-token'];           // "Bearer xxxx"
  }
  function stmt(verb, display, result){
    return { actor: actor, verb: { id: verb, display: { 'en-US': display } },
      object: { objectType:'Activity', id: activityId },
      context: { registration: registration }, result: result };
  }
  async function send(token, body){
    return fetch(endpoint + 'statements', { method:'POST',
      headers:{ 'Content-Type':'application/json', 'Authorization': token,
        'X-Experience-API-Version':'1.0.3' }, body: JSON.stringify(body) });
  }
  (async function(){
    try {
      var token = await auth();
      await send(token, stmt('http://adlnet.gov/expapi/verbs/launched','launched'));
      await send(token, stmt('http://adlnet.gov/expapi/verbs/initialized','initialized'));
      s.textContent = 'initialized (token ok)';
      document.getElementById('pass').onclick = async function(){
        await send(token, stmt('http://adlnet.gov/expapi/verbs/passed','passed', { score:{ scaled:0.9 } }));
        await send(token, stmt('http://adlnet.gov/expapi/verbs/completed','completed', { completion:true }));
        await send(token, stmt('http://adlnet.gov/expapi/verbs/terminated','terminated'));
        s.textContent = 'passed + completed sent';
      };
    } catch(e){ s.textContent = 'ERROR: ' + e.message; }
  })();
</script>
</body></html>`;

async function build(name, files) {
  const zip = new JSZip();
  for (const [p, content] of Object.entries(files)) zip.file(p, content);
  const buf = await zip.generateAsync({ type: "nodebuffer" });
  const out = path.join(here, name);
  fs.writeFileSync(out, buf);
  console.log(`wrote ${out} (${buf.length} bytes)`);
}

await build("scorm12.zip", { "imsmanifest.xml": scormManifest, "index.html": scormHtml });
await build("cmi5.zip", { "cmi5.xml": cmi5Xml, "index.html": cmi5Html });
console.log("done.");
