/**
 * Report generator. Reads every per-worker shard from bot-report/raw/, dedupes
 * findings by fingerprint (counting recurrences and collecting the URLs/roles
 * each was seen under), and renders three artefacts:
 *   - findings.json  (machine-readable, for CI gating / dashboards)
 *   - bug-report.md  (human triage list with repro steps)
 *   - index.html     (self-contained dashboard with screenshots & filters)
 */

import fs from "node:fs";
import path from "node:path";
import { OUT_HTML, OUT_JSON, OUT_MD, RAW_DIR } from "./paths";
import type { BotRunSummary, CrawlStat, Finding, Severity } from "./types";

const SEVERITY_ORDER: Severity[] = ["critical", "high", "medium", "low", "info"];

interface AggFinding extends Finding {
  count: number;
  urls: string[];
  roles: string[];
}

function readShards(): { findings: Finding[]; stats: CrawlStat[] } {
  const findings: Finding[] = [];
  const stats: CrawlStat[] = [];
  if (!fs.existsSync(RAW_DIR)) return { findings, stats };
  for (const file of fs.readdirSync(RAW_DIR)) {
    const full = path.join(RAW_DIR, file);
    const lines = fs.readFileSync(full, "utf8").split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (file.startsWith("findings-")) findings.push(obj as Finding);
        else if (file.startsWith("stats-")) stats.push(obj as CrawlStat);
      } catch {
        /* skip malformed line */
      }
    }
  }
  return { findings, stats };
}

function aggregate(findings: Finding[]): AggFinding[] {
  const byFp = new Map<string, AggFinding>();
  for (const f of findings) {
    const existing = byFp.get(f.fingerprint);
    if (existing) {
      existing.count++;
      if (!existing.urls.includes(f.url)) existing.urls.push(f.url);
      if (!existing.roles.includes(f.role)) existing.roles.push(f.role);
      // Keep the first screenshot we captured.
      if (!existing.screenshot && f.screenshot) existing.screenshot = f.screenshot;
    } else {
      byFp.set(f.fingerprint, {
        ...f,
        count: 1,
        urls: [f.url],
        roles: [f.role],
      });
    }
  }
  const list = Array.from(byFp.values());
  list.sort(
    (a, b) =>
      SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) ||
      b.count - a.count
  );
  return list;
}

export interface ReportMeta {
  startedAt: string;
  finishedAt: string;
  baseURL: string;
}

export function generateReport(meta: ReportMeta): BotRunSummary {
  const { findings: raw, stats } = readShards();
  const agg = aggregate(raw);

  const totals = SEVERITY_ORDER.reduce(
    (acc, s) => ((acc[s] = agg.filter((f) => f.severity === s).length), acc),
    {} as Record<Severity, number>
  );
  const byCategory: Record<string, number> = {};
  for (const f of agg) byCategory[f.category] = (byCategory[f.category] ?? 0) + 1;

  const summary: BotRunSummary = {
    startedAt: meta.startedAt,
    finishedAt: meta.finishedAt,
    baseURL: meta.baseURL,
    totals,
    byCategory,
    pagesVisited: new Set(stats.map((s) => `${s.role} ${s.url}`)).size,
    apisProbed: 0,
    findings: agg,
    crawlStats: stats,
  };

  fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
  fs.writeFileSync(OUT_JSON, JSON.stringify(summary, null, 2));
  fs.writeFileSync(OUT_MD, renderMarkdown(summary, agg));
  fs.writeFileSync(OUT_HTML, renderHtml(summary, agg));
  return summary;
}

function renderMarkdown(s: BotRunSummary, findings: AggFinding[]): string {
  const lines: string[] = [];
  lines.push(`# LMS Testing Bot — Bug Report`);
  lines.push("");
  lines.push(`- **Target:** ${s.baseURL}`);
  lines.push(`- **Run:** ${s.startedAt} → ${s.finishedAt}`);
  lines.push(`- **Pages visited:** ${s.pagesVisited}`);
  lines.push(
    `- **Findings:** ${findings.length} unique — ` +
      SEVERITY_ORDER.map((sev) => `${s.totals[sev]} ${sev}`).join(", ")
  );
  lines.push("");
  for (const sev of SEVERITY_ORDER) {
    const group = findings.filter((f) => f.severity === sev);
    if (!group.length) continue;
    lines.push(`## ${sev.toUpperCase()} (${group.length})`);
    lines.push("");
    for (const f of group) {
      lines.push(`### ${f.title}`);
      lines.push(`- **Category:** ${f.category}  |  **Role:** ${f.roles.join(", ")}  |  **Seen:** ${f.count}×`);
      lines.push(`- **Area:** ${f.area ?? "-"}`);
      lines.push(`- **URL(s):** ${f.urls.slice(0, 5).join(", ")}`);
      lines.push(`- **Detail:** ${escapeMd(f.detail)}`);
      if (f.repro.length) {
        lines.push(`- **Reproduce:**`);
        f.repro.forEach((r, i) => lines.push(`  ${i + 1}. ${escapeMd(r)}`));
      }
      if (f.screenshot) lines.push(`- **Screenshot:** \`${f.screenshot}\``);
      if (f.logs?.length) {
        lines.push(`- **Logs:**`);
        lines.push("  ```");
        f.logs.slice(0, 5).forEach((l) => lines.push("  " + l.replace(/\n/g, " ")));
        lines.push("  ```");
      }
      lines.push("");
    }
  }
  if (!findings.length) lines.push("✅ No defects recorded.");
  return lines.join("\n");
}

function renderHtml(s: BotRunSummary, findings: AggFinding[]): string {
  const color: Record<Severity, string> = {
    critical: "#b91c1c",
    high: "#ea580c",
    medium: "#ca8a04",
    low: "#2563eb",
    info: "#6b7280",
  };
  const cards = SEVERITY_ORDER.map(
    (sev) => `<div class="card" style="border-color:${color[sev]}">
      <div class="num" style="color:${color[sev]}">${s.totals[sev]}</div>
      <div class="lbl">${sev}</div></div>`
  ).join("");

  const rows = findings
    .map((f) => {
      const shot = f.screenshot
        ? `<a href="${f.screenshot}" target="_blank">view</a>`
        : "—";
      const repro = f.repro.map((r) => `<li>${esc(r)}</li>`).join("");
      const logs = f.logs?.length
        ? `<pre>${esc(f.logs.slice(0, 5).join("\n"))}</pre>`
        : "";
      return `<tr class="row sev-${f.severity}" data-sev="${f.severity}">
        <td><span class="pill" style="background:${color[f.severity]}">${f.severity}</span></td>
        <td>${esc(f.category)}</td>
        <td>
          <div class="title">${esc(f.title)}</div>
          <div class="detail">${esc(f.detail)}</div>
          <details><summary>repro &amp; logs</summary><ol>${repro}</ol>${logs}</details>
        </td>
        <td>${esc(f.roles.join(", "))}</td>
        <td class="urls">${f.urls.slice(0, 3).map(esc).join("<br>")}</td>
        <td>${f.count}</td>
        <td>${shot}</td>
      </tr>`;
    })
    .join("");

  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>LMS Bot Report</title>
<style>
  :root{font-family:ui-sans-serif,system-ui,Segoe UI,Roboto,sans-serif}
  body{margin:0;background:#0f172a;color:#e2e8f0}
  header{padding:20px 28px;background:#111827;border-bottom:1px solid #1f2937}
  h1{margin:0 0 4px;font-size:20px}
  .meta{color:#94a3b8;font-size:13px}
  .cards{display:flex;gap:12px;padding:18px 28px;flex-wrap:wrap}
  .card{background:#111827;border:2px solid;border-radius:10px;padding:12px 18px;min-width:90px;text-align:center}
  .num{font-size:28px;font-weight:700}
  .lbl{text-transform:uppercase;font-size:11px;color:#94a3b8;letter-spacing:.05em}
  .filters{padding:0 28px 12px}
  .filters button{background:#1f2937;color:#e2e8f0;border:1px solid #374151;border-radius:6px;padding:6px 12px;margin-right:6px;cursor:pointer;font-size:12px}
  .filters button.active{background:#2563eb;border-color:#2563eb}
  table{width:calc(100% - 56px);margin:0 28px 40px;border-collapse:collapse;font-size:13px}
  th,td{text-align:left;padding:10px;border-bottom:1px solid #1f2937;vertical-align:top}
  th{color:#94a3b8;font-size:11px;text-transform:uppercase;position:sticky;top:0;background:#0f172a}
  .pill{color:#fff;padding:2px 8px;border-radius:999px;font-size:11px;text-transform:uppercase}
  .title{font-weight:600}
  .detail{color:#94a3b8;margin-top:2px}
  .urls{color:#7dd3fc;font-family:ui-monospace,monospace;font-size:11px}
  pre{white-space:pre-wrap;background:#0b1220;padding:8px;border-radius:6px;color:#fca5a5;font-size:11px;overflow:auto}
  details summary{cursor:pointer;color:#60a5fa;margin-top:6px}
  a{color:#60a5fa}
  .empty{padding:60px;text-align:center;color:#22c55e;font-size:18px}
</style></head><body>
<header>
  <h1>🤖 LMS Testing Bot — Report</h1>
  <div class="meta">Target: ${esc(s.baseURL)} · ${esc(s.startedAt)} → ${esc(s.finishedAt)} · ${s.pagesVisited} pages visited · ${findings.length} unique findings</div>
</header>
<div class="cards">${cards}</div>
<div class="filters">
  <button data-f="all" class="active">All</button>
  ${SEVERITY_ORDER.map((sev) => `<button data-f="${sev}">${sev}</button>`).join("")}
</div>
${
  findings.length
    ? `<table><thead><tr><th>Sev</th><th>Category</th><th>Finding</th><th>Role</th><th>URL(s)</th><th>×</th><th>Shot</th></tr></thead><tbody>${rows}</tbody></table>`
    : `<div class="empty">✅ No defects recorded across the crawl, journeys, and API probes.</div>`
}
<script>
  const btns=[...document.querySelectorAll('.filters button')];
  btns.forEach(b=>b.onclick=()=>{
    btns.forEach(x=>x.classList.remove('active'));b.classList.add('active');
    const f=b.dataset.f;
    document.querySelectorAll('tr.row').forEach(r=>{
      r.style.display=(f==='all'||r.dataset.sev===f)?'':'none';
    });
  });
</script>
</body></html>`;
}

function esc(s: string): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escapeMd(s: string): string {
  return String(s).replace(/\|/g, "\\|").replace(/\n/g, " ");
}
