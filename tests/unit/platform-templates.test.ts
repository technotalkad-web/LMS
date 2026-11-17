/**
 * The platform's own email text (ADR 0029 section F; lib/email/platform-templates.ts):
 *   - every platform event renders a fixed subject, text and HTML, made from
 *     the same blocks;
 *   - a message carries only values the server made: a six-digit code, its
 *     minutes, an http or https address without credentials, a cleaned
 *     organisation name, a fixed role label, a fixed SMTP reading; no
 *     password, no person's name, no tenant branding;
 *   - the organisation's name is plain text cut to 60 characters, with
 *     anything shaped like a link or an address removed;
 *   - content that fails its check throws, before anything could be sent.
 *
 * No database, no network.
 *
 * Run:  npx tsx tests/unit/platform-templates.test.ts   (or npm run test:unit)
 */
import {
  PLATFORM_EVENTS,
  PlatformTemplateError,
  cleanOrganizationName,
  isPlatformEvent,
  renderPlatformEmail,
  type PlatformContent,
  type PlatformEvent,
} from "../../lib/email/platform-templates";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};
const throws = (fn: () => unknown): string => {
  try { fn(); return "no throw"; } catch (e) { return e instanceof PlatformTemplateError ? "PlatformTemplateError" : `other: ${String(e)}`; }
};

const SIGN_IN = "https://lms.stub/acme/login";
const LINK = "https://lms.stub/auth/finish?token_hash=abc123&type=magiclink";
const SETTINGS = "https://lms.stub/acme/settings?tab=smtp";

const GOOD: { [E in PlatformEvent]: PlatformContent[E] } = {
  platform_reset_code: { code: "482913", minutes: 10 },
  platform_sign_in_link: { link: LINK, minutes: 60 },
  platform_admin_welcome: { organizationName: "Acme Learning", signInUrl: SIGN_IN, role: "admin" },
  tenant_smtp_alert: { organizationName: "Acme Learning", settingsUrl: SETTINGS, reading: "failing", errorClass: "auth" },
  platform_test: {},
};

console.log("\nthe events");
eq("five platform events, in the routing table's order", [...PLATFORM_EVENTS], ["platform_reset_code", "platform_sign_in_link", "platform_admin_welcome", "tenant_smtp_alert", "platform_test"]);
eq("a tenant event is not a platform event", ["password_reset", "magic_link", "account_creation", "custom_broadcast"].map(isPlatformEvent), [false, false, false, false]);
eq("rendering a tenant event throws", throws(() => renderPlatformEmail("password_reset" as PlatformEvent, {} as never)), "PlatformTemplateError");

console.log("\nevery event renders a subject, a text and an HTML page with the same content");
for (const event of PLATFORM_EVENTS) {
  const r = renderPlatformEmail(event, GOOD[event] as never);
  eq(`${event}: subject, text and html are non-empty`, [r.subject.length > 0, r.text.length > 0, r.html.startsWith("<!doctype html>")], [true, true, true]);
  const paragraphs = r.text.trim().split("\n\n");
  const htmlText = r.html.replace(/<[^>]+>/g, "\n").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
  eq(`${event}: every text paragraph is in the HTML`, paragraphs.filter((p) => !htmlText.includes(p)), []);
  eq(`${event}: no image, script, style sheet or outside resource`, /<img|<script|<link|<iframe|src=|url\(/i.test(r.html), false);
  eq(`${event}: the subject has no line break`, /[\r\n]/.test(r.subject), false);
}

console.log("\nthe values a message carries");
{
  const code = renderPlatformEmail("platform_reset_code", GOOD.platform_reset_code);
  eq("the reset code: the code and its minutes", [code.text.includes("482913"), code.text.includes("10 minutes"), code.html.includes("482913")], [true, true, true]);
  const link = renderPlatformEmail("platform_sign_in_link", GOOD.platform_sign_in_link);
  eq("the sign-in link: the link, escaped in the HTML", [link.text.includes(LINK), link.html.includes(LINK.replace(/&/g, "&amp;")), link.html.includes(`href="${LINK.replace(/&/g, "&amp;")}"`)], [true, true, true]);
  for (const role of ["super_owner", "admin", "data_analyst"] as const) {
    const w = renderPlatformEmail("platform_admin_welcome", { ...GOOD.platform_admin_welcome, role });
    const label = { super_owner: "Super owner", admin: "Administrator", data_analyst: "Data analyst" }[role];
    // The only line that mentions a password is the fixed sentence saying the email never holds one.
    const passwordLines = w.text.split("\n").filter((l) => /password/i.test(l));
    eq(`the welcome for ${role}: the organisation, the sign-in address and the role; the only password line is the fixed one`, [w.text.includes("Acme Learning"), w.text.includes(SIGN_IN), w.text.includes(`Your role: ${label}.`), passwordLines], [true, true, true, ["The person who created your account gives you your first password; this email never contains one. If you do not have it, choose \"Forgot password?\" on that page."]]);
  }
  for (const [reading, cls, words] of [
    ["failing", "auth", "refused the sign-in"],
    ["failing", "quota", "sending limit"],
    ["failing", "timeout", "did not answer in time"],
    ["failing", "unreachable", "could not be reached"],
    ["failing", "unknown", "reported an error"],
    ["failing", null, "reported an error"],
    ["not_configured", null, "no complete SMTP settings"],
  ] as const) {
    const a = renderPlatformEmail("tenant_smtp_alert", { ...GOOD.tenant_smtp_alert, reading, errorClass: cls });
    eq(`the alert, ${reading}${cls ? ` (${cls})` : ""}: the fixed reason, the learners' message and the settings address`, [a.text.includes(words), a.text.includes("Email could not be sent. Please contact your LMS Administrator."), a.text.includes(SETTINGS)], [true, true, true]);
  }
  const t = renderPlatformEmail("platform_test", {});
  eq("the test: fixed text only", t.text.includes("test message from the LMS platform sender"), true);
}

console.log("\nonly server-made values: extra fields are never rendered");
{
  const extra = { password: "Hunter2-Secret!", learner_name: "Pat Person", logo_url: "https://cdn.stub/logo.png", reply_to: "help@tenant.stub", subject: "Click here", body_md: "**free text**", brand_color: "#ff00ff" };
  const outs = PLATFORM_EVENTS.map((e) => renderPlatformEmail(e, { ...(GOOD[e] as object), ...extra } as never));
  const all = outs.map((o) => o.subject + o.text + o.html).join("\n");
  eq("no password, name, logo, Reply-To, free subject or body, or colour from the content", Object.values(extra).filter((v) => all.includes(v)), []);
}

console.log("\nthe organisation's name");
{
  eq("plain text kept", cleanOrganizationName("Acme Learning & Co."), "Acme Learning & Co.");
  eq("a link removed", cleanOrganizationName("Acme https://evil.stub/login now"), "Acme now");
  eq("a web address removed", cleanOrganizationName("Visit www.evil.stub today"), "Visit today");
  eq("a domain removed", cleanOrganizationName("Acme evil.stub Ltd"), "Acme Ltd");
  eq("an email address removed", cleanOrganizationName("Write to boss@evil.stub please"), "Write to please");
  eq("a javascript: or mailto: value removed", cleanOrganizationName("A javascript:alert(1) B mailto:x C"), "A B C");
  eq("a full-width dot is read as a dot (NFKC), so the domain goes", cleanOrganizationName("Acme evil\uff0estub"), "Acme");
  eq("line breaks and direction controls removed (no header or display trick)", cleanOrganizationName("Acme\r\nBcc: x\u202eLtd"), "Acme Bcc: x Ltd");
  eq("angle brackets removed", cleanOrganizationName("<b>Acme</b>"), "b Acme /b");
  const long = "Very Long Organisation Name ".repeat(5);
  eq("cut to 60 characters", cleanOrganizationName(long).length <= 60 && cleanOrganizationName(long).startsWith("Very Long Organisation Name"), true);
  eq("cut by characters, not code units", Array.from(cleanOrganizationName("\u{1F600}".repeat(70))).length, 60);
  eq("empty, not a string, or nothing left: the fallback", [cleanOrganizationName(""), cleanOrganizationName(null), cleanOrganizationName(42), cleanOrganizationName("https://x.stub")], ["your organisation", "your organisation", "your organisation", "your organisation"]);
  const w = renderPlatformEmail("platform_admin_welcome", { ...GOOD.platform_admin_welcome, organizationName: "Tom & Jerry <script>alert(1)</script> https://evil.stub" });
  eq("the welcome escapes the cleaned name in its HTML", [w.html.includes("<script>"), w.html.includes("Tom &amp; Jerry"), w.text.includes("evil.stub")], [false, true, false]);
}

console.log("\ncontent that fails its check throws");
{
  const bad: Array<[string, PlatformEvent, unknown]> = [
    ["a five-digit code", "platform_reset_code", { code: "12345", minutes: 10 }],
    ["a code with letters", "platform_reset_code", { code: "12a456", minutes: 10 }],
    ["a code that is a number", "platform_reset_code", { code: 123456, minutes: 10 }],
    ["zero minutes", "platform_reset_code", { code: "123456", minutes: 0 }],
    ["fractional minutes", "platform_sign_in_link", { link: LINK, minutes: 1.5 }],
    ["a javascript: link", "platform_sign_in_link", { link: "javascript:alert(1)", minutes: 10 }],
    ["a data: link", "platform_sign_in_link", { link: "data:text/html,hi", minutes: 10 }],
    ["a relative link", "platform_sign_in_link", { link: "/auth/finish", minutes: 10 }],
    ["a link with credentials", "platform_sign_in_link", { link: "https://u:p@lms.stub/x", minutes: 10 }],
    ["a link with a quote", "platform_sign_in_link", { link: 'https://lms.stub/x"onmouseover=1', minutes: 10 }],
    ["a link with a space", "platform_sign_in_link", { link: "https://lms.stub/x y", minutes: 10 }],
    ["a welcome with the legacy role owner", "platform_admin_welcome", { organizationName: "A", signInUrl: SIGN_IN, role: "owner" }],
    ["a welcome with no sign-in address", "platform_admin_welcome", { organizationName: "A", role: "admin" }],
    ["an alert with an unknown reading", "tenant_smtp_alert", { organizationName: "A", settingsUrl: SETTINGS, reading: "healthy", errorClass: null }],
    ["an alert with an unknown class", "tenant_smtp_alert", { organizationName: "A", settingsUrl: SETTINGS, reading: "failing", errorClass: "boom" }],
    // An inherited key of a plain object is not a value of the list.
    ["a welcome with the role constructor", "platform_admin_welcome", { organizationName: "A", signInUrl: SIGN_IN, role: "constructor" }],
    ["a welcome with the role __proto__", "platform_admin_welcome", { organizationName: "A", signInUrl: SIGN_IN, role: "__proto__" }],
    ["a welcome with the role toString", "platform_admin_welcome", { organizationName: "A", signInUrl: SIGN_IN, role: "toString" }],
    ["a welcome with no role", "platform_admin_welcome", { organizationName: "A", signInUrl: SIGN_IN }],
    ["an alert with the class constructor", "tenant_smtp_alert", { organizationName: "A", settingsUrl: SETTINGS, reading: "failing", errorClass: "constructor" }],
    ["an alert with the class __proto__", "tenant_smtp_alert", { organizationName: "A", settingsUrl: SETTINGS, reading: "failing", errorClass: "__proto__" }],
    ["an alert with the class none (the map's own fallback key, not a class)", "tenant_smtp_alert", { organizationName: "A", settingsUrl: SETTINGS, reading: "failing", errorClass: "none" }],
    ["an alert with the class rejected (a recipient's refusal never raises an alert)", "tenant_smtp_alert", { organizationName: "A", settingsUrl: SETTINGS, reading: "failing", errorClass: "rejected" }],
  ];
  for (const [label, event, content] of bad) eq(label, throws(() => renderPlatformEmail(event, content as never)), "PlatformTemplateError");
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
