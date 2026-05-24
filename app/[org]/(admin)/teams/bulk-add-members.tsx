"use client";

import { useMemo, useState } from "react";
import { Check, ClipboardPaste, ListChecks, Search, X } from "lucide-react";

export type Candidate = {
  user_id: string;
  email: string;
  role: string;
};

type Mode = "pick" | "paste";

/**
 * Bulk add-members UI for a team. Two modes side-by-side via tabs:
 *
 *   1. PICK — searchable list of org members not yet in the team, with a
 *      checkbox per row, "select all visible" header check, and live
 *      "N selected" counter. Click "Add N members" to commit.
 *
 *   2. PASTE — textarea where admin pastes a newline-separated list of
 *      emails. We match against the candidate list (case-insensitive by
 *      email). Preview shows matched (will be added) and unmatched
 *      (won't, with reason — not in org, or already a member). Click
 *      "Add N matched" to commit only the matches.
 *
 * The component is presentation-only — it doesn't talk to the API. The
 * parent (teams-client.tsx) owns the side-effect via the onAdd prop, so
 * loading state, router.refresh, and error toasts stay co-located with
 * the rest of the team-management code.
 */
export function BulkAddMembers({
  candidates,
  existingEmails,
  onAdd,
  busy,
}: {
  /** Org members NOT yet in this team. */
  candidates: Candidate[];
  /** Emails of users ALREADY in this team — used to give better
   *  "why didn't this match" feedback in paste mode. */
  existingEmails: string[];
  /** Called with the user_ids to add. Parent handles the network call. */
  onAdd: (userIds: string[]) => Promise<void>;
  busy: boolean;
}) {
  const [mode, setMode] = useState<Mode>("pick");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pasteText, setPasteText] = useState("");
  const [pasteParsed, setPasteParsed] = useState<{
    matched: Candidate[];
    alreadyMember: string[];
    notInOrg: string[];
  } | null>(null);

  // ---- PICK mode ------------------------------------------------------
  const filteredCandidates = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return candidates;
    return candidates.filter((c) => c.email.toLowerCase().includes(q));
  }, [candidates, query]);

  const allVisibleSelected =
    filteredCandidates.length > 0 &&
    filteredCandidates.every((c) => selected.has(c.user_id));

  function toggleOne(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  }

  function toggleAllVisible() {
    const next = new Set(selected);
    if (allVisibleSelected) {
      for (const c of filteredCandidates) next.delete(c.user_id);
    } else {
      for (const c of filteredCandidates) next.add(c.user_id);
    }
    setSelected(next);
  }

  async function commitPick() {
    if (selected.size === 0) return;
    await onAdd(Array.from(selected));
    setSelected(new Set());
    setQuery("");
  }

  // ---- PASTE mode -----------------------------------------------------
  function parsePaste() {
    // Split by newlines, commas, semicolons, or whitespace runs — admin
    // might paste from a spreadsheet column, a comma list, or whatever.
    const raw = pasteText
      .split(/[\n,;\s]+/g)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    const seen = new Set<string>();
    const deduped = raw.filter((e) => {
      if (seen.has(e)) return false;
      seen.add(e);
      return true;
    });
    const byEmail = new Map(
      candidates.map((c) => [c.email.toLowerCase(), c])
    );
    const existingSet = new Set(existingEmails.map((e) => e.toLowerCase()));
    const matched: Candidate[] = [];
    const alreadyMember: string[] = [];
    const notInOrg: string[] = [];
    for (const e of deduped) {
      const cand = byEmail.get(e);
      if (cand) matched.push(cand);
      else if (existingSet.has(e)) alreadyMember.push(e);
      else notInOrg.push(e);
    }
    setPasteParsed({ matched, alreadyMember, notInOrg });
  }

  async function commitPaste() {
    if (!pasteParsed || pasteParsed.matched.length === 0) return;
    await onAdd(pasteParsed.matched.map((c) => c.user_id));
    setPasteText("");
    setPasteParsed(null);
  }

  // ---- Render ---------------------------------------------------------
  return (
    <div className="border border-line rounded-xl bg-paper">
      {/* Tabs */}
      <div className="flex border-b border-line bg-canvas/40 rounded-t-xl overflow-hidden">
        <TabButton
          active={mode === "pick"}
          onClick={() => setMode("pick")}
          icon={<ListChecks className="w-3.5 h-3.5" />}
          label="Pick from list"
          count={candidates.length}
        />
        <TabButton
          active={mode === "paste"}
          onClick={() => setMode("paste")}
          icon={<ClipboardPaste className="w-3.5 h-3.5" />}
          label="Paste emails"
        />
      </div>

      {/* Body */}
      <div className="p-3">
        {mode === "pick" ? (
          <>
            <div className="flex items-center gap-2 mb-2">
              <div className="relative flex-1">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted pointer-events-none" />
                <input
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={`Search ${candidates.length} candidates by email…`}
                  className="w-full pl-8 pr-3 py-1.5 border border-line rounded-lg bg-canvas text-xs outline-none focus:border-ink"
                />
              </div>
              {filteredCandidates.length > 0 && (
                <label className="flex items-center gap-1.5 text-[11px] text-muted cursor-pointer shrink-0">
                  <input
                    type="checkbox"
                    checked={allVisibleSelected}
                    onChange={toggleAllVisible}
                  />
                  Select all visible
                </label>
              )}
            </div>
            <div className="max-h-64 overflow-y-auto border border-line rounded-lg bg-canvas">
              {filteredCandidates.length === 0 ? (
                <p className="text-center text-muted text-xs py-6">
                  {candidates.length === 0
                    ? "Every org member is already in this team."
                    : `No candidates match "${query}".`}
                </p>
              ) : (
                <ul className="divide-y divide-line">
                  {filteredCandidates.map((c) => (
                    <li key={c.user_id}>
                      <label className="flex items-center gap-2 px-3 py-1.5 hover:bg-paper cursor-pointer text-xs">
                        <input
                          type="checkbox"
                          checked={selected.has(c.user_id)}
                          onChange={() => toggleOne(c.user_id)}
                        />
                        <span className="flex-1 truncate">{c.email}</span>
                        <span className="text-muted/80 capitalize text-[10px] shrink-0">
                          {c.role.replace(/_/g, " ")}
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        ) : (
          <>
            <textarea
              value={pasteText}
              onChange={(e) => {
                setPasteText(e.target.value);
                setPasteParsed(null);
              }}
              rows={5}
              placeholder={`Paste emails — one per line, or separated by commas/semicolons.\n\njane@example.com\njohn@example.com\nadarsh@ambak.com`}
              className="w-full px-3 py-2 border border-line rounded-lg bg-canvas text-xs outline-none focus:border-ink font-mono"
            />
            <div className="flex items-center justify-between mt-2">
              <button
                type="button"
                onClick={parsePaste}
                disabled={!pasteText.trim()}
                className="inline-flex items-center gap-1 text-xs px-3 py-1.5 border border-line rounded-lg hover:border-ink disabled:opacity-50"
              >
                Parse &amp; match
              </button>
              {pasteParsed && (
                <span className="text-[11px] text-muted">
                  {pasteParsed.matched.length} matched
                  {pasteParsed.alreadyMember.length > 0 &&
                    ` · ${pasteParsed.alreadyMember.length} already in team`}
                  {pasteParsed.notInOrg.length > 0 &&
                    ` · ${pasteParsed.notInOrg.length} not in org`}
                </span>
              )}
            </div>
            {pasteParsed && (
              <div className="mt-2 max-h-48 overflow-y-auto border border-line rounded-lg bg-canvas p-2 text-[11px] space-y-2">
                {pasteParsed.matched.length > 0 && (
                  <details open>
                    <summary className="cursor-pointer text-emerald-700 font-medium">
                      <Check className="inline w-3 h-3 mr-1" />
                      Will be added ({pasteParsed.matched.length})
                    </summary>
                    <ul className="mt-1 ml-4 text-muted">
                      {pasteParsed.matched.slice(0, 50).map((c) => (
                        <li key={c.user_id}>{c.email}</li>
                      ))}
                      {pasteParsed.matched.length > 50 && (
                        <li className="text-muted/60">
                          …and {pasteParsed.matched.length - 50} more
                        </li>
                      )}
                    </ul>
                  </details>
                )}
                {pasteParsed.alreadyMember.length > 0 && (
                  <details>
                    <summary className="cursor-pointer text-amber-700 font-medium">
                      Already in team ({pasteParsed.alreadyMember.length})
                    </summary>
                    <ul className="mt-1 ml-4 text-muted">
                      {pasteParsed.alreadyMember.slice(0, 30).map((e) => (
                        <li key={e}>{e}</li>
                      ))}
                      {pasteParsed.alreadyMember.length > 30 && (
                        <li className="text-muted/60">
                          …and {pasteParsed.alreadyMember.length - 30} more
                        </li>
                      )}
                    </ul>
                  </details>
                )}
                {pasteParsed.notInOrg.length > 0 && (
                  <details>
                    <summary className="cursor-pointer text-red-700 font-medium">
                      <X className="inline w-3 h-3 mr-1" />
                      Not in this org ({pasteParsed.notInOrg.length})
                    </summary>
                    <ul className="mt-1 ml-4 text-muted">
                      {pasteParsed.notInOrg.slice(0, 30).map((e) => (
                        <li key={e}>{e}</li>
                      ))}
                      {pasteParsed.notInOrg.length > 30 && (
                        <li className="text-muted/60">
                          …and {pasteParsed.notInOrg.length - 30} more
                        </li>
                      )}
                    </ul>
                    <p className="mt-1 ml-4 text-[10px] text-muted/70 italic">
                      These emails don&apos;t belong to any user in this org.
                      Invite them via Users → New first, then come back.
                    </p>
                  </details>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {/* Footer / commit */}
      <div className="flex items-center justify-between px-3 py-2 border-t border-line bg-canvas/40 rounded-b-xl">
        <span className="text-[11px] text-muted">
          {mode === "pick"
            ? `${selected.size} selected`
            : pasteParsed
              ? `${pasteParsed.matched.length} ready to add`
              : "Paste, then click Parse & match"}
        </span>
        <button
          type="button"
          onClick={mode === "pick" ? commitPick : commitPaste}
          disabled={
            busy ||
            (mode === "pick" && selected.size === 0) ||
            (mode === "paste" &&
              (!pasteParsed || pasteParsed.matched.length === 0))
          }
          className="inline-flex items-center gap-1 px-3 py-1.5 bg-ink text-canvas rounded-lg text-xs font-semibold hover:opacity-90 disabled:opacity-50"
        >
          <Check className="w-3.5 h-3.5" />
          {busy
            ? "Adding…"
            : mode === "pick"
              ? selected.size > 0
                ? `Add ${selected.size} ${selected.size === 1 ? "member" : "members"}`
                : "Add members"
              : pasteParsed && pasteParsed.matched.length > 0
                ? `Add ${pasteParsed.matched.length} matched`
                : "Add matched"}
        </button>
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  icon,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  count?: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium transition-colors ${
        active
          ? "bg-paper text-ink border-b-2 border-ink -mb-px"
          : "text-muted hover:text-ink"
      }`}
    >
      {icon}
      {label}
      {typeof count === "number" && (
        <span
          className={`text-[10px] px-1.5 py-0.5 rounded-full ${
            active ? "bg-canvas" : "bg-canvas/60"
          }`}
        >
          {count}
        </span>
      )}
    </button>
  );
}
