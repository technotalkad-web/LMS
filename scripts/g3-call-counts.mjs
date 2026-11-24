#!/usr/bin/env node
/**
 * Reads the log of scripts/g3-call-counter.cjs (ADR 0029, gate G3) and prints
 * one JSON line for each labelled request: its status, the calls it caused
 * from its start to the end of its work after the response, by host kind,
 * the share before and after the answer, the middleware's share, the calls
 * before its first send, and whether its calls had settled.
 *
 *   node scripts/g3-call-counts.mjs <log> [label-prefix]
 *
 * A request counts as settled when it has finished, every undici call it
 * made has ended, and it made no call for 5 seconds. One that is not settled
 * is printed with `settled: false`; read it again later. Numbers and fixed
 * words only: the log holds no URL, header value or body.
 */
import fs from "node:fs";

const [file, prefix = ""] = process.argv.slice(2);
if (!file) {
  console.error("usage: node scripts/g3-call-counts.mjs <log> [label-prefix]");
  process.exit(2);
}
const QUIET_MS = 5_000;
const KINDS = ["rest", "auth", "send_smtp", "other"];
const LETTER = { rest: "R", auth: "A", send_smtp: "S", other: "O" };

const events = fs
  .readFileSync(file, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  })
  .filter(Boolean);

const bySeq = new Map();
for (const e of events) {
  if (!bySeq.has(e.seq)) bySeq.set(e.seq, []);
  bySeq.get(e.seq).push(e);
}
const byKind = (xs) => Object.fromEntries(KINDS.map((k) => [k, xs.filter((e) => e.kind === k).length]));
const now = Date.now();

for (const [seq, mine] of bySeq) {
  const start = mine.find((e) => e.ev === "start");
  if (!start || start.label === "unlabelled" || !start.label.startsWith(prefix)) continue;
  const finish = mine.find((e) => e.ev === "finish");
  // The fetch wrapper's own lines are a cross-check of the undici lines, not calls of their own.
  const calls = mine.filter((e) => e.ev === "call" && e.src !== "fetch");
  const undici = calls.filter((e) => e.src === "undici").length;
  const ended = mine.filter((e) => e.ev === "done").length;
  const last = Math.max(...mine.map((e) => e.t));
  const sequence = calls.map((e) => LETTER[e.kind] ?? "O").join("");
  const firstSend = sequence.indexOf("S");
  console.log(
    JSON.stringify({
      label: start.label,
      status: finish?.status ?? null,
      calls: calls.length,
      split: byKind(calls),
      before_answer: calls.filter((e) => !e.after).length,
      after_answer: calls.filter((e) => e.after).length,
      middleware: calls.filter((e) => e.src === "undici" && e.via === "direct").length,
      before_first_send: firstSend < 0 ? null : firstSend,
      sequence,
      not_undici: calls.filter((e) => e.src !== "undici").length,
      fetch_cross_check: mine.filter((e) => e.ev === "call" && e.src === "fetch").length === calls.filter((e) => e.src === "undici" && e.via === "fetch").length,
      unattributed_in_window: events.filter((e) => e.ev === "call" && e.seq === 0 && e.t >= start.t && e.t <= last).length,
      settled: !!finish && undici === ended && now - last >= QUIET_MS,
      seq,
    })
  );
}
