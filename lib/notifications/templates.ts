import { createClient as createServiceClient } from "@supabase/supabase-js";
import type { NotificationEvent } from "./types";

/**
 * Default seed text for each event. Used when an org hasn't customized
 * the template yet.
 */
export const DEFAULT_TEMPLATES: Record<
  NotificationEvent,
  { subject: string; body_md: string }
> = {
  account_creation: {
    subject: "Welcome to {Org_Name}",
    body_md: `Hi {Learner_Name},

Your account on the **{Org_Name}** learning portal is ready.

- **Sign-in URL:** {Portal_URL}
- **Username:** {Username}
- **Password:** {Password}

Sign in to see the courses assigned to you.

— The {Org_Name} team`,
  },
  asset_assignment: {
    subject: "New course assigned: {Course_Name}",
    body_md: `Hi {Learner_Name},

You've been assigned a new course on **{Org_Name}**.

- **Course:** {Course_Name}
- **Direct link:** {Direct_Link}

{Due_Date}

— The {Org_Name} team`,
  },
  asset_unassignment: {
    subject: "Removed from {Course_Name}",
    body_md: `Hi {Learner_Name},

You've been removed from **{Course_Name}** on {Org_Name}. Nothing to do — just a heads-up.`,
  },
  asset_completion: {
    subject: "Nice work! You completed {Course_Name}",
    body_md: `Hi {Learner_Name},

You just finished **{Course_Name}**. 🎉

{Score}

You can see all your progress at {Portal_URL}.`,
  },
  asset_reminder: {
    subject: "Reminder: finish {Course_Name}",
    body_md: `Hi {Learner_Name},

You haven't finished **{Course_Name}** yet. It only takes a few minutes — pick up where you left off:

{Direct_Link}

— The {Org_Name} team`,
  },
  asset_update: {
    subject: "Update: {Course_Name} has new content",
    body_md: `Hi {Learner_Name},

A course you're enrolled in on **{Org_Name}** has been updated.

- **What changed:** {Course_Name}{Path_Name}
- **What this means:** previously completed work stays completed; only newly added content needs to be done.

Hop in to see what's new:

— The {Org_Name} team`,
  },
  custom_broadcast: {
    subject: "{Org_Name} update",
    body_md: `Hi {Learner_Name},

(Your message goes here.)`,
  },
  path_assignment: {
    subject: "New learning path: {Path_Name}",
    body_md: `Hi {Learner_Name},

You've been enrolled in **{Path_Name}**, a curated sequence of courses on {Org_Name}.

Each course must be completed in order. Start the first one any time.`,
  },
  path_unassignment: {
    subject: "Removed from {Path_Name}",
    body_md: `Hi {Learner_Name},

You've been removed from the **{Path_Name}** learning path on {Org_Name}. Nothing to do — just a heads-up.`,
  },
  path_completion: {
    subject: "You finished {Path_Name}! 🎉",
    body_md: `Hi {Learner_Name},

You completed **{Path_Name}** on {Org_Name}. Every course in the path is done.

Take a moment — you earned it.`,
  },
  password_reset: {
    subject: "Your {Org_Name} verification code",
    body_md: `Hi there,

Use this 6-digit code to reset your password on **{Org_Name}**:

# {OTP_Code}

The code expires in {OTP_Minutes} minutes. If you didn't request this, you can ignore this email.

— The {Org_Name} team`,
  },
};

/**
 * Load a template for an org+event, falling back to defaults.
 * Returns the CTA label if one is configured for the template.
 */
export async function loadTemplate(
  organizationId: string,
  event: NotificationEvent
): Promise<{ subject: string; body_md: string; cta_label: string | null }> {
  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
  const { data } = await svc
    .from("notification_templates")
    .select("subject, body_md, is_active, cta_label")
    .eq("organization_id", organizationId)
    .eq("event_type", event)
    .maybeSingle();
  if (data && data.is_active) {
    return {
      subject: data.subject as string,
      body_md: data.body_md as string,
      cta_label: (data.cta_label as string | null) ?? null,
    };
  }
  return { ...DEFAULT_TEMPLATES[event], cta_label: DEFAULT_CTAS[event] ?? null };
}

/** Default CTA labels per event so emails always have a primary action. */
export const DEFAULT_CTAS: Partial<Record<NotificationEvent, string>> = {
  account_creation: "Sign in",
  asset_assignment: "Start course",
  asset_completion: "View progress",
  asset_reminder: "Continue",
  asset_update: "See what's new",
  path_assignment: "Open path",
  path_completion: "See your progress",
};

/**
 * Minimal Markdown → HTML conversion for transactional emails. Supports
 * the common subset: paragraphs, bold (**), italic (*), inline code (`),
 * unordered lists (- ), bare-URL links, and explicit [text](url) links.
 * Multi-paragraph blocks are wrapped in <p>. Newlines inside become <br>.
 *
 * This keeps the codebase free of a Markdown dep. Power-user formatting
 * (tables, headings, blockquotes) is intentionally out of scope.
 */
export function mdToHtml(md: string): string {
  const escape = (s: string) =>
    s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

  const blocks = md.split(/\n\s*\n/); // split on blank lines
  const htmlBlocks = blocks.map((block) => {
    const lines = block.split("\n");
    // List?
    if (lines.every((l) => /^\s*[-*]\s+/.test(l))) {
      const items = lines.map((l) => {
        const inner = l.replace(/^\s*[-*]\s+/, "");
        return `<li>${inline(escape(inner))}</li>`;
      });
      return `<ul style="margin:0 0 12px 18px;padding:0">${items.join("")}</ul>`;
    }
    // Paragraph (with <br> for soft breaks)
    const txt = lines.map((l) => inline(escape(l))).join("<br>");
    return `<p style="margin:0 0 12px">${txt}</p>`;
  });
  return htmlBlocks.join("");

  function inline(s: string): string {
    // [text](url)
    s = s.replace(
      /\[([^\]]+)\]\(([^)]+)\)/g,
      (_m, text: string, url: string) =>
        `<a href="${url}" style="color:#1a1816;text-decoration:underline">${text}</a>`
    );
    // Bare URLs
    s = s.replace(
      /(^|\s)(https?:\/\/[^\s<]+)/g,
      (_m, pre: string, url: string) =>
        `${pre}<a href="${url}" style="color:#1a1816;text-decoration:underline">${url}</a>`
    );
    // **bold**
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    // *italic*
    s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
    // `code`
    s = s.replace(
      /`([^`]+)`/g,
      '<code style="background:#f3f3f1;padding:1px 4px;border-radius:3px;font-family:ui-monospace,monospace;font-size:90%">$1</code>'
    );
    // # H1 (used by password_reset for the big OTP code)
    s = s.replace(
      /^# (.+)$/gm,
      '<h1 style="font-size:32px;letter-spacing:0.4em;text-align:center;margin:16px 0;font-family:ui-monospace,monospace">$1</h1>'
    );
    return s;
  }
}
