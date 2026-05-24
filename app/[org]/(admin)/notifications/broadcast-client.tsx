"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import {
  Users as UsersIcon,
  User,
  UsersRound,
  BookOpen,
  Map as MapIcon,
  Send,
  CheckCircle2,
  AlertTriangle,
  Search,
  Plus,
  X as XIcon,
  Link as LinkIcon,
} from "lucide-react";
import { Card, KpiCard, KpiStrip } from "@/components/admin";
import { mdToHtml } from "@/lib/notifications/templates";

export type RecipientUser = { user_id: string; email: string };
export type RecipientTeam = { id: string; name: string };
export type RecipientCourse = { id: string; title: string };
export type RecipientPath = { id: string; name: string };

type Audience = "all" | "team" | "users" | "course" | "path";

type ButtonRow =
  | { type: "course"; label: string; course_id: string }
  | { type: "path"; label: string; path_id: string }
  | { type: "profile"; label: string }
  | { type: "custom"; label: string; url: string };

type ButtonType = ButtonRow["type"];

const MAX_BUTTONS = 3;

const BUTTON_TYPE_LABELS: Record<ButtonType, string> = {
  course: "Course",
  path: "Learning path",
  profile: "Profile",
  custom: "Custom URL",
};

const DEFAULT_BUTTON_LABEL: Record<ButtonType, string> = {
  course: "Open course",
  path: "View path",
  profile: "Update profile",
  custom: "Open link",
};

const AUDIENCE_OPTIONS: Array<{
  key: Audience;
  label: string;
  description: string;
  icon: React.ReactNode;
}> = [
  { key: "all", label: "Everyone", description: "All active members in the org", icon: <UsersIcon className="w-4 h-4" /> },
  { key: "team", label: "A team", description: "Members of a specific team", icon: <UsersRound className="w-4 h-4" /> },
  { key: "users", label: "Specific users", description: "Hand-pick recipients", icon: <User className="w-4 h-4" /> },
  { key: "course", label: "Course audience", description: "Learners enrolled in a course", icon: <BookOpen className="w-4 h-4" /> },
  { key: "path", label: "Path audience", description: "Learners on a learning path", icon: <MapIcon className="w-4 h-4" /> },
];

export function BroadcastClient({
  orgSlug, users, teams, courses, paths,
}: {
  orgSlug: string;
  users: RecipientUser[];
  teams: RecipientTeam[];
  courses: RecipientCourse[];
  paths: RecipientPath[];
}) {
  const router = useRouter();
  const [audience, setAudience] = useState<Audience>("all");
  const [teamId, setTeamId] = useState<string>("");
  const [courseId, setCourseId] = useState<string>("");
  const [pathId, setPathId] = useState<string>("");
  const [selectedUsers, setSelectedUsers] = useState<Set<string>>(new Set());
  const [userQuery, setUserQuery] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [buttons, setButtons] = useState<ButtonRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ sent: number; failed: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  function toggleUser(id: string) {
    const next = new Set(selectedUsers);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelectedUsers(next);
  }

  function addButton() {
    if (buttons.length >= MAX_BUTTONS) return;
    setButtons([...buttons, { type: "course", label: DEFAULT_BUTTON_LABEL.course, course_id: "" }]);
  }
  function removeButton(idx: number) { setButtons(buttons.filter((_, i) => i !== idx)); }
  function changeButtonType(idx: number, newType: ButtonType) {
    setButtons(buttons.map((b, i) => {
      if (i !== idx) return b;
      const oldDefault = DEFAULT_BUTTON_LABEL[b.type];
      const label = b.label === oldDefault ? DEFAULT_BUTTON_LABEL[newType] : b.label;
      switch (newType) {
        case "course": return { type: "course", label, course_id: "" };
        case "path": return { type: "path", label, path_id: "" };
        case "profile": return { type: "profile", label };
        case "custom": return { type: "custom", label, url: "" };
      }
    }));
  }
  function updateButton(idx: number, patch: Partial<ButtonRow>) {
    setButtons(buttons.map((b, i) => (i === idx ? ({ ...b, ...patch } as ButtonRow) : b)));
  }
  function buttonComplete(b: ButtonRow): boolean {
    if (!b.label.trim()) return false;
    if (b.type === "course") return Boolean(b.course_id);
    if (b.type === "path") return Boolean(b.path_id);
    if (b.type === "custom") return /^https?:\/\//i.test(b.url.trim());
    return true;
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!subject.trim() || !body.trim()) return;
    setBusy(true); setError(null); setResult(null);
    const payload: Record<string, unknown> = { orgSlug, subject, body_md: body, audience };
    if (audience === "team") payload.team_id = teamId;
    if (audience === "users") payload.user_ids = Array.from(selectedUsers);
    if (audience === "course") payload.course_id = courseId;
    if (audience === "path") payload.path_id = pathId;
    const cleanButtons = buttons.filter(buttonComplete);
    if (cleanButtons.length > 0) payload.buttons = cleanButtons;
    const res = await fetch("/api/notifications/broadcast", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    setBusy(false);
    const j = (await res.json().catch(() => ({}))) as { sent?: number; failed?: number; total?: number; error?: string };
    if (!res.ok) { setError(j.error ?? "Send failed"); return; }
    setResult({ sent: j.sent ?? 0, failed: j.failed ?? 0, total: j.total ?? 0 });
    setSubject(""); setBody(""); setButtons([]);
    router.refresh();
  }

  const preview = mdToHtml(body);
  const completeButtonsForPreview = buttons.filter(buttonComplete);

  const filteredUsers = useMemo(() => {
    const q = userQuery.trim().toLowerCase();
    if (!q) return users;
    return users.filter((u) => u.email.toLowerCase().includes(q));
  }, [users, userQuery]);

  const disabled = busy || !subject.trim() || !body.trim() ||
    (audience === "team" && !teamId) ||
    (audience === "course" && !courseId) ||
    (audience === "path" && !pathId) ||
    (audience === "users" && selectedUsers.size === 0);

  return (
    <div className="space-y-6">
      {result && (
        <Card className="p-5">
          <div className="flex items-center gap-2 mb-3">
            {result.failed === 0 ? <CheckCircle2 className="w-4 h-4 text-emerald-600" /> : <AlertTriangle className="w-4 h-4 text-amber-600" />}
            <h2 className="serif text-xl text-ink">Broadcast sent</h2>
          </div>
          <KpiStrip>
            <KpiCard label="Recipients" value={result.total} />
            <KpiCard label="Sent" value={result.sent} accent="text-emerald-600" icon={<CheckCircle2 className="w-4 h-4" />} />
            <KpiCard label="Failed" value={result.failed} accent={result.failed > 0 ? "text-red-600" : undefined} icon={<AlertTriangle className="w-4 h-4" />} />
          </KpiStrip>
        </Card>
      )}

      <Card className="p-5">
        <div className="mb-5">
          <h2 className="serif text-xl text-ink">Compose broadcast</h2>
          <p className="text-xs text-muted mt-1">Pick an audience, write your message in Markdown, optionally attach up to {MAX_BUTTONS} action buttons, and send.</p>
        </div>

        <form onSubmit={submit} className="space-y-5">
          <div>
            <label className="block text-[10px] sm:text-[11px] font-semibold tracking-wider text-muted uppercase mb-2">Audience</label>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
              {AUDIENCE_OPTIONS.map((opt) => {
                const isActive = audience === opt.key;
                return (
                  <button key={opt.key} type="button" onClick={() => setAudience(opt.key)}
                    className={`text-left px-3 py-3 border rounded-xl transition-all flex items-start gap-3 ${isActive ? "border-ink bg-ink text-canvas shadow-sm" : "border-line bg-paper hover:border-ink/40"}`}>
                    <div className={`shrink-0 mt-0.5 ${isActive ? "text-canvas" : "text-ink"}`}>{opt.icon}</div>
                    <div className="min-w-0">
                      <div className="text-sm font-semibold leading-tight">{opt.label}</div>
                      <div className={`text-[11px] leading-snug mt-0.5 ${isActive ? "text-canvas/70" : "text-muted"}`}>{opt.description}</div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {audience === "team" && (
            <div>
              <label className="block text-[10px] sm:text-[11px] font-semibold tracking-wider text-muted uppercase mb-2">Team</label>
              <select value={teamId} onChange={(e) => setTeamId(e.target.value)} className="w-full px-3 py-2.5 border border-line rounded-xl bg-canvas outline-none focus:border-ink focus:ring-2 focus:ring-ink/10 text-sm">
                <option value="">Pick a team...</option>
                {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
          )}

          {audience === "course" && (
            <div>
              <label className="block text-[10px] sm:text-[11px] font-semibold tracking-wider text-muted uppercase mb-2">Course</label>
              <select value={courseId} onChange={(e) => setCourseId(e.target.value)} className="w-full px-3 py-2.5 border border-line rounded-xl bg-canvas outline-none focus:border-ink focus:ring-2 focus:ring-ink/10 text-sm">
                <option value="">Pick a course...</option>
                {courses.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
              </select>
              <p className="text-[11px] text-muted mt-1.5">Reaches every learner with a direct, team, or org-wide assignment to this course.</p>
            </div>
          )}

          {audience === "path" && (
            <div>
              <label className="block text-[10px] sm:text-[11px] font-semibold tracking-wider text-muted uppercase mb-2">Learning path</label>
              <select value={pathId} onChange={(e) => setPathId(e.target.value)} className="w-full px-3 py-2.5 border border-line rounded-xl bg-canvas outline-none focus:border-ink focus:ring-2 focus:ring-ink/10 text-sm">
                <option value="">Pick a learning path...</option>
                {paths.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              <p className="text-[11px] text-muted mt-1.5">Reaches every learner assigned to this path.</p>
            </div>
          )}

          {audience === "users" && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="block text-[10px] sm:text-[11px] font-semibold tracking-wider text-muted uppercase">Recipients</label>
                <span className="text-xs text-muted">{selectedUsers.size} selected</span>
              </div>
              <div className="relative mb-2">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted pointer-events-none" />
                <input type="text" value={userQuery} onChange={(e) => setUserQuery(e.target.value)} placeholder="Search users by email..." className="w-full pl-9 pr-3 py-2 bg-canvas border border-line rounded-xl text-sm outline-none focus:border-ink" />
              </div>
              <div className="max-h-56 overflow-y-auto border border-line rounded-xl bg-canvas p-2 text-sm">
                {filteredUsers.length === 0 ? <p className="text-center text-muted text-xs py-4">No users match.</p> : filteredUsers.map((u) => (
                  <label key={u.user_id} className="flex items-center gap-2 px-2 py-1.5 hover:bg-paper rounded-lg cursor-pointer">
                    <input type="checkbox" checked={selectedUsers.has(u.user_id)} onChange={() => toggleUser(u.user_id)} />
                    <span className="text-xs">{u.email}</span>
                  </label>
                ))}
              </div>
            </div>
          )}

          <div>
            <label className="block text-[10px] sm:text-[11px] font-semibold tracking-wider text-muted uppercase mb-2">Subject</label>
            <input type="text" required value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Quarterly compliance refresher available now" className="w-full px-3 py-2.5 border border-line rounded-xl bg-canvas outline-none focus:border-ink focus:ring-2 focus:ring-ink/10 text-sm" />
          </div>

          <div>
            <label className="block text-[10px] sm:text-[11px] font-semibold tracking-wider text-muted uppercase mb-2">Message (Markdown)</label>
            <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={8} placeholder="Write your message... use **bold**, _italic_, and [links](https://example.com)." className="w-full px-3 py-2.5 border border-line rounded-xl bg-canvas outline-none focus:border-ink focus:ring-2 focus:ring-ink/10 font-mono text-xs" />
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="block text-[10px] sm:text-[11px] font-semibold tracking-wider text-muted uppercase">
                Action buttons
                <span className="text-muted/70 font-normal normal-case ml-2">(optional · max {MAX_BUTTONS})</span>
              </label>
              {buttons.length < MAX_BUTTONS && (
                <button type="button" onClick={addButton} className="inline-flex items-center gap-1 text-xs text-ink/80 hover:text-ink px-2 py-1 rounded-lg border border-line hover:border-ink/40">
                  <Plus className="w-3.5 h-3.5" />Add button
                </button>
              )}
            </div>
            {buttons.length === 0 ? (
              <p className="text-[11px] text-muted">No buttons attached. Click <strong>Add button</strong> to include direct links to a course, learning path, the user&apos;s profile, or any URL. The first button becomes the primary call-to-action in the email.</p>
            ) : (
              <div className="space-y-2">
                {buttons.map((btn, idx) => (
                  <div key={idx} className="border border-line rounded-xl bg-canvas/40 p-3">
                    <div className="flex items-center gap-2 mb-2">
                      <span className={`inline-flex items-center justify-center w-6 h-6 rounded-full text-[10px] font-semibold ${idx === 0 ? "bg-ink text-canvas" : "bg-canvas border border-line text-muted"}`}>{idx + 1}</span>
                      <span className="text-[10px] uppercase tracking-wide text-muted">{idx === 0 ? "Primary" : "Secondary"}</span>
                      <button type="button" onClick={() => removeButton(idx)} className="ml-auto text-muted hover:text-red-700" aria-label="Remove button">
                        <XIcon className="w-4 h-4" />
                      </button>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-12 gap-2">
                      <div className="sm:col-span-3">
                        <select value={btn.type} onChange={(e) => changeButtonType(idx, e.target.value as ButtonType)} className="w-full px-2 py-1.5 border border-line rounded-lg bg-paper text-xs outline-none focus:border-ink">
                          {(Object.keys(BUTTON_TYPE_LABELS) as ButtonType[]).map((t) => <option key={t} value={t}>{BUTTON_TYPE_LABELS[t]}</option>)}
                        </select>
                      </div>
                      <div className="sm:col-span-4">
                        <input type="text" value={btn.label} onChange={(e) => updateButton(idx, { label: e.target.value })} maxLength={80} placeholder={DEFAULT_BUTTON_LABEL[btn.type]} className="w-full px-2 py-1.5 border border-line rounded-lg bg-paper text-xs outline-none focus:border-ink" />
                      </div>
                      <div className="sm:col-span-5">
                        {btn.type === "course" && (
                          <select value={btn.course_id} onChange={(e) => updateButton(idx, { course_id: e.target.value })} className="w-full px-2 py-1.5 border border-line rounded-lg bg-paper text-xs outline-none focus:border-ink">
                            <option value="">Pick a course...</option>
                            {courses.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
                          </select>
                        )}
                        {btn.type === "path" && (
                          <select value={btn.path_id} onChange={(e) => updateButton(idx, { path_id: e.target.value })} className="w-full px-2 py-1.5 border border-line rounded-lg bg-paper text-xs outline-none focus:border-ink">
                            <option value="">Pick a learning path...</option>
                            {paths.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                          </select>
                        )}
                        {btn.type === "profile" && (
                          <div className="flex items-center gap-1.5 px-2 py-1.5 text-[11px] text-muted">
                            <LinkIcon className="w-3 h-3" />
                            <span>Links to <code>/{orgSlug}/profile</code></span>
                          </div>
                        )}
                        {btn.type === "custom" && (
                          <input type="url" value={btn.url} onChange={(e) => updateButton(idx, { url: e.target.value })} placeholder="https://example.com/..." className="w-full px-2 py-1.5 border border-line rounded-lg bg-paper text-xs outline-none focus:border-ink" />
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {(body || completeButtonsForPreview.length > 0) && (
            <div>
              <label className="block text-[10px] sm:text-[11px] font-semibold tracking-wider text-muted uppercase mb-2">Preview</label>
              <div className="border border-line rounded-xl bg-canvas p-3 text-sm">
                {body && <div className="prose prose-sm max-w-none" dangerouslySetInnerHTML={{ __html: preview }} />}
                {completeButtonsForPreview.length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {completeButtonsForPreview.map((b, i) => (
                      <span key={i} className={`inline-block px-4 py-2 rounded-md text-xs font-semibold ${i === 0 ? "bg-ink text-canvas" : "border border-ink text-ink bg-paper"}`}>
                        {b.label}{i === 0 && " →"}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {error && <div className="border border-red-200 bg-red-50 text-red-900 rounded-xl p-3 text-sm">{error}</div>}

          <div className="flex justify-end pt-2 border-t border-line">
            <button type="submit" disabled={disabled} className="inline-flex items-center gap-2 px-5 py-2.5 bg-ink text-canvas rounded-xl text-sm font-semibold hover:opacity-90 disabled:opacity-50 transition-opacity shadow-sm">
              <Send className="w-4 h-4" />
              {busy ? "Sending..." : "Send broadcast"}
            </button>
          </div>
        </form>
      </Card>
    </div>
  );
}
