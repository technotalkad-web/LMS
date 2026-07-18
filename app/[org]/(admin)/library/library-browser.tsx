"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  BookOpen,
  Clock,
  Users as UsersIcon,
  Folder,
  FolderPlus,
  FolderInput,
  MoreVertical,
  Pencil,
  Trash2,
  ChevronRight,
  QrCode,
} from "lucide-react";
import { StatusPill, EmptyState, Card } from "@/components/admin";
import { useToast } from "@/components/ui/toast";
import { useConfirm } from "@/components/ui/confirm";
import { QrCodeModal } from "../_components/qr-code-modal";

export type FolderLite = { id: string; name: string; parent_id: string | null };
export type CourseLite = {
  id: string;
  title: string;
  description: string | null;
  current_version_id: string | null;
  thumbnail_url: string | null;
  duration_minutes: number | null;
  is_active: boolean;
  folder_id: string | null;
  enrolled: number;
};

function formatDuration(mins: number | null): string | null {
  if (mins === null || mins <= 0) return null;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

export function LibraryBrowser({
  orgSlug,
  canManage,
  currentFolderId,
  folders,
  courses,
}: {
  orgSlug: string;
  canManage: boolean;
  currentFolderId: string | null;
  folders: FolderLite[];
  courses: CourseLite[];
}) {
  const router = useRouter();
  const toast = useToast();
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [qrTarget, setQrTarget] = useState<{ title: string; path: string } | null>(null);

  // Modals
  const [namePrompt, setNamePrompt] = useState<
    | { mode: "create" }
    | { mode: "rename"; folderId: string; current: string }
    | null
  >(null);
  const [movePick, setMovePick] = useState<
    | { kind: "course"; id: string; label: string }
    | { kind: "folder"; id: string; label: string }
    | null
  >(null);

  const byId = useMemo(
    () => new Map(folders.map((f) => [f.id, f])),
    [folders]
  );
  const childrenOf = useMemo(() => {
    const m = new Map<string | null, FolderLite[]>();
    for (const f of folders) {
      const arr = m.get(f.parent_id) ?? [];
      arr.push(f);
      m.set(f.parent_id, arr);
    }
    return m;
  }, [folders]);

  const subfolders = childrenOf.get(currentFolderId) ?? [];
  const folderCourses = courses.filter((c) => c.folder_id === currentFolderId);

  // Breadcrumb: walk parents from current up to root.
  const breadcrumb = useMemo(() => {
    const path: Array<{ id: string | null; name: string }> = [];
    let cur: string | null = currentFolderId;
    let hops = 0;
    while (cur && hops < 1000) {
      const f = byId.get(cur);
      if (!f) break;
      path.unshift({ id: f.id, name: f.name });
      cur = f.parent_id;
      hops++;
    }
    path.unshift({ id: null, name: "Library" });
    return path;
  }, [byId, currentFolderId]);

  function folderHref(id: string | null) {
    return id ? `/${orgSlug}/library?folder=${id}` : `/${orgSlug}/library`;
  }

  // Direct counts for a folder card.
  function folderCounts(id: string) {
    const subs = (childrenOf.get(id) ?? []).length;
    const crs = courses.filter((c) => c.folder_id === id).length;
    return { subs, crs };
  }

  async function api(url: string, method: string, body: unknown) {
    setBusy(true);
    const res = await fetch(url, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    setBusy(false);
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) {
      toast.error(j.error ?? "Something went wrong");
      return false;
    }
    return true;
  }

  async function createFolder(name: string) {
    const ok = await api("/api/folders", "POST", {
      orgSlug,
      name,
      parentId: currentFolderId,
    });
    if (ok) {
      toast.success(`Folder "${name}" created`);
      router.refresh();
    }
  }

  async function renameFolder(folderId: string, name: string) {
    const ok = await api(`/api/folders/${folderId}`, "PATCH", { orgSlug, name });
    if (ok) {
      toast.success("Folder renamed");
      router.refresh();
    }
  }

  async function deleteFolder(folderId: string, name: string) {
    const yes = await confirm({
      title: `Delete "${name}"?`,
      message:
        "Its courses and subfolders move up to the parent folder. No course is deleted.",
      confirmText: "Delete folder",
      destructive: true,
    });
    if (!yes) return;
    const ok = await api(`/api/folders/${folderId}`, "DELETE", { orgSlug });
    if (ok) {
      toast.success("Folder deleted");
      router.refresh();
    }
  }

  async function moveTo(targetFolderId: string | null) {
    if (!movePick) return;
    let ok = false;
    if (movePick.kind === "course") {
      ok = await api(`/api/courses/${movePick.id}`, "PATCH", {
        folder_id: targetFolderId,
      });
    } else {
      ok = await api(`/api/folders/${movePick.id}`, "PATCH", {
        orgSlug,
        parentId: targetFolderId,
      });
    }
    if (ok) {
      toast.success("Moved");
      setMovePick(null);
      router.refresh();
    }
  }

  return (
    <div className="mt-6">
      {/* Toolbar: breadcrumb + new folder */}
      <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
        <nav aria-label="Breadcrumb" className="text-sm">
          <ol className="flex items-center flex-wrap gap-1">
            {breadcrumb.map((c, i) => (
              <li key={c.id ?? "root"} className="flex items-center gap-1">
                {i > 0 && <ChevronRight className="w-3.5 h-3.5 text-muted" aria-hidden />}
                {i === breadcrumb.length - 1 ? (
                  <span className="font-medium text-ink">{c.name}</span>
                ) : (
                  <Link href={folderHref(c.id)} className="text-muted hover:text-ink">
                    {c.name}
                  </Link>
                )}
              </li>
            ))}
          </ol>
        </nav>
        {canManage && (
          <button
            type="button"
            onClick={() => setNamePrompt({ mode: "create" })}
            disabled={busy}
            className="inline-flex items-center gap-2 px-3 py-1.5 border border-line rounded-lg text-sm hover:border-ink disabled:opacity-50"
          >
            <FolderPlus className="w-4 h-4" />
            New folder
          </button>
        )}
      </div>

      {/* Subfolders */}
      {subfolders.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 mb-5">
          {subfolders.map((f) => {
            const { subs, crs } = folderCounts(f.id);
            return (
              <div
                key={f.id}
                className="relative group bg-paper border border-line rounded-xl p-4 transition-all hover:border-ink/30 hover:shadow-sm"
              >
                <Link href={folderHref(f.id)} className="flex items-center gap-3 pr-8">
                  <span className="shrink-0 inline-flex h-10 w-10 items-center justify-center rounded-lg bg-accent/10 text-accent">
                    <Folder className="w-5 h-5" />
                  </span>
                  <span className="min-w-0">
                    <span className="block font-medium text-ink truncate">{f.name}</span>
                    <span className="block text-xs text-muted">
                      {crs} course{crs === 1 ? "" : "s"}
                      {subs > 0 && ` · ${subs} folder${subs === 1 ? "" : "s"}`}
                    </span>
                  </span>
                </Link>
                {canManage && (
                  <div className="absolute top-3 right-2">
                    <button
                      type="button"
                      aria-label="Folder actions"
                      onClick={() => setMenuFor(menuFor === f.id ? null : f.id)}
                      className="p-1.5 rounded-md text-muted hover:bg-canvas hover:text-ink"
                    >
                      <MoreVertical className="w-4 h-4" />
                    </button>
                    {menuFor === f.id && (
                      <>
                        <div
                          className="fixed inset-0 z-10"
                          onClick={() => setMenuFor(null)}
                          aria-hidden
                        />
                        <div className="absolute right-0 z-20 mt-1 w-40 rounded-lg border border-line bg-paper shadow-lg py-1 text-sm">
                          <button
                            type="button"
                            onClick={() => {
                              setMenuFor(null);
                              setNamePrompt({ mode: "rename", folderId: f.id, current: f.name });
                            }}
                            className="w-full flex items-center gap-2 px-3 py-2 hover:bg-canvas text-left"
                          >
                            <Pencil className="w-3.5 h-3.5" /> Rename
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setMenuFor(null);
                              setMovePick({ kind: "folder", id: f.id, label: f.name });
                            }}
                            className="w-full flex items-center gap-2 px-3 py-2 hover:bg-canvas text-left"
                          >
                            <FolderInput className="w-3.5 h-3.5" /> Move
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setMenuFor(null);
                              deleteFolder(f.id, f.name);
                            }}
                            className="w-full flex items-center gap-2 px-3 py-2 hover:bg-red-50 text-red-600 text-left"
                          >
                            <Trash2 className="w-3.5 h-3.5" /> Delete
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Courses in this folder */}
      {folderCourses.length === 0 && subfolders.length === 0 ? (
        <Card>
          <EmptyState
            icon={<BookOpen className="w-5 h-5" />}
            title={currentFolderId ? "This folder is empty" : "No courses yet"}
            description={
              canManage
                ? "Upload a course or create a folder to organise your catalog."
                : "Nothing here yet."
            }
          />
        </Card>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {folderCourses.map((c) => {
            const duration = formatDuration(c.duration_minutes);
            return (
              <div
                key={c.id}
                className="relative group bg-paper border border-line rounded-xl overflow-hidden transition-all hover:border-ink/30 hover:shadow-sm flex flex-col"
              >
                <Link href={`/${orgSlug}/library/${c.id}`} className="flex flex-col flex-1">
                  {c.thumbnail_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={c.thumbnail_url}
                      alt=""
                      className="aspect-video w-full object-cover rounded-t-xl"
                    />
                  ) : (
                    <div className="aspect-video w-full bg-canvas rounded-t-xl flex items-center justify-center text-muted">
                      <BookOpen className="w-8 h-8 opacity-40" />
                    </div>
                  )}
                  <div className="p-4 flex-1 flex flex-col gap-2">
                    <h3 className="serif text-lg leading-snug text-ink line-clamp-2 pr-6">
                      {c.title}
                    </h3>
                    {c.description ? (
                      <p className="text-sm text-muted line-clamp-2">{c.description}</p>
                    ) : (
                      <p className="text-sm text-muted italic">No description</p>
                    )}
                    <div className="mt-auto pt-3 flex items-center justify-between gap-2 flex-wrap">
                      <StatusPill tone={c.is_active ? "active" : "neutral"}>
                        {c.is_active ? "Active" : "Inactive"}
                      </StatusPill>
                      <div className="flex items-center gap-3 text-xs text-muted">
                        {duration && (
                          <span className="inline-flex items-center gap-1">
                            <Clock className="w-3 h-3" />
                            {duration}
                          </span>
                        )}
                        <span className="inline-flex items-center gap-1">
                          <UsersIcon className="w-3 h-3" />
                          {c.enrolled}
                        </span>
                        {!c.current_version_id && (
                          <span className="text-amber-700">no version</span>
                        )}
                      </div>
                    </div>
                  </div>
                </Link>
                {canManage && (
                  <>
                    <button
                      type="button"
                      aria-label="Move course"
                      title="Move to folder"
                      onClick={() => setMovePick({ kind: "course", id: c.id, label: c.title })}
                      className="absolute top-2 right-2 p-1.5 rounded-md bg-paper/90 border border-line text-muted hover:text-ink opacity-0 group-hover:opacity-100 transition-opacity"
                    >
                      <FolderInput className="w-4 h-4" />
                    </button>
                    <button
                      type="button"
                      aria-label="Share QR code"
                      title="Share via QR code"
                      onClick={() =>
                        setQrTarget({ title: c.title, path: `/${orgSlug}/courses/${c.id}` })
                      }
                      className="absolute top-2 right-11 p-1.5 rounded-md bg-paper/90 border border-line text-muted hover:text-ink opacity-0 group-hover:opacity-100 transition-opacity"
                    >
                      <QrCode className="w-4 h-4" />
                    </button>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}

      {qrTarget && (
        <QrCodeModal
          title={qrTarget.title}
          path={qrTarget.path}
          kind="course"
          onClose={() => setQrTarget(null)}
        />
      )}

      {namePrompt && (
        <NamePrompt
          title={namePrompt.mode === "create" ? "New folder" : "Rename folder"}
          initial={namePrompt.mode === "rename" ? namePrompt.current : ""}
          busy={busy}
          onCancel={() => setNamePrompt(null)}
          onSubmit={async (name) => {
            const p = namePrompt;
            setNamePrompt(null);
            if (p.mode === "create") await createFolder(name);
            else await renameFolder(p.folderId, name);
          }}
        />
      )}

      {movePick && (
        <MovePicker
          label={movePick.label}
          folders={folders}
          childrenOf={childrenOf}
          excludeSubtreeOf={movePick.kind === "folder" ? movePick.id : null}
          busy={busy}
          onCancel={() => setMovePick(null)}
          onPick={moveTo}
        />
      )}
    </div>
  );
}

/* ---------- Modals ---------- */

function Backdrop({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-ink/30"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm bg-paper border border-line rounded-2xl shadow-xl p-5"
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

function NamePrompt({
  title,
  initial,
  busy,
  onCancel,
  onSubmit,
}: {
  title: string;
  initial: string;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (name: string) => void;
}) {
  const [name, setName] = useState(initial);
  const trimmed = name.trim();
  return (
    <Backdrop onClose={onCancel}>
      <h3 className="serif text-xl mb-3">{title}</h3>
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && trimmed) onSubmit(trimmed);
          if (e.key === "Escape") onCancel();
        }}
        placeholder="Folder name"
        className="w-full px-3 py-2 border border-line rounded-lg bg-canvas outline-none focus:border-ink text-sm"
      />
      <div className="flex justify-end gap-2 mt-4">
        <button
          type="button"
          onClick={onCancel}
          className="px-4 py-2 border border-line rounded-lg text-sm hover:border-ink"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={!trimmed || busy}
          onClick={() => onSubmit(trimmed)}
          className="px-4 py-2 bg-ink text-canvas rounded-lg text-sm font-medium hover:opacity-90 disabled:opacity-50"
        >
          Save
        </button>
      </div>
    </Backdrop>
  );
}

function MovePicker({
  label,
  folders,
  childrenOf,
  excludeSubtreeOf,
  busy,
  onCancel,
  onPick,
}: {
  label: string;
  folders: FolderLite[];
  childrenOf: Map<string | null, FolderLite[]>;
  excludeSubtreeOf: string | null;
  busy: boolean;
  onCancel: () => void;
  onPick: (folderId: string | null) => void;
}) {
  // Exclude the folder itself + its descendants (can't move into own subtree).
  const excluded = useMemo(() => {
    const set = new Set<string>();
    if (excludeSubtreeOf) {
      const stack = [excludeSubtreeOf];
      while (stack.length) {
        const id = stack.pop()!;
        set.add(id);
        for (const ch of childrenOf.get(id) ?? []) stack.push(ch.id);
      }
    }
    return set;
  }, [excludeSubtreeOf, childrenOf]);

  // Flatten the tree depth-first for an indented list.
  const rows = useMemo(() => {
    const out: Array<{ id: string; name: string; depth: number }> = [];
    const walk = (parent: string | null, depth: number) => {
      for (const f of childrenOf.get(parent) ?? []) {
        if (excluded.has(f.id)) continue;
        out.push({ id: f.id, name: f.name, depth });
        walk(f.id, depth + 1);
      }
    };
    walk(null, 0);
    return out;
  }, [childrenOf, excluded, folders]);

  return (
    <Backdrop onClose={onCancel}>
      <h3 className="serif text-xl mb-1">Move</h3>
      <p className="text-xs text-muted mb-3 truncate">{label}</p>
      <div className="max-h-72 overflow-auto border border-line rounded-lg divide-y divide-line">
        <button
          type="button"
          disabled={busy}
          onClick={() => onPick(null)}
          className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-canvas text-left disabled:opacity-50"
        >
          <Folder className="w-4 h-4 text-muted" /> Library (root)
        </button>
        {rows.map((r) => (
          <button
            key={r.id}
            type="button"
            disabled={busy}
            onClick={() => onPick(r.id)}
            className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-canvas text-left disabled:opacity-50"
            style={{ paddingLeft: `${12 + r.depth * 16}px` }}
          >
            <Folder className="w-4 h-4 text-accent" /> {r.name}
          </button>
        ))}
      </div>
      <div className="flex justify-end mt-4">
        <button
          type="button"
          onClick={onCancel}
          className="px-4 py-2 border border-line rounded-lg text-sm hover:border-ink"
        >
          Cancel
        </button>
      </div>
    </Backdrop>
  );
}
