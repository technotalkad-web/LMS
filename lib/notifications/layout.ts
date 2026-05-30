/**
 * Renders a polished, email-client-safe HTML wrapper around the body
 * markup. We use a table-based outer scaffold (the only layout that
 * works reliably across Outlook + Gmail) with inline styles throughout
 * (most clients strip <style> tags or scope them aggressively).
 *
 * The shell is intentionally narrow (max-width 600px) and uses high-
 * contrast colors with a single brand accent. Logo, brand color, and
 * footer text are all per-org configurable.
 */

export type EmailBranding = {
  orgName: string;
  logoUrl: string | null;
  brandColor: string; // hex, e.g. "#3a5a40"
  footerText: string | null;
};

export type EmailLayoutArgs = {
  subject: string;
  bodyHtml: string;          // already mdToHtml-rendered
  branding: EmailBranding;
  ctaLabel?: string | null;
  ctaUrl?: string | null;
  // Multi-button mode used by the broadcast composer. When provided
  // and non-empty, the renderer ignores ctaLabel/ctaUrl and renders
  // these instead — first button is the primary (filled, brand color),
  // subsequent buttons are secondary (outlined). All 10 transactional
  // email types (account_creation, asset_assignment, etc.) leave this
  // undefined and continue to use the legacy single-CTA path
  // unchanged. Max 3 buttons enforced at the UI; the renderer itself
  // accepts any number.
  ctaButtons?: Array<{ label: string; url: string }>;
};

export function renderEmailShell(args: EmailLayoutArgs): string {
  const { subject, bodyHtml, branding, ctaLabel, ctaUrl, ctaButtons } = args;
  const brand = sanitizeHex(branding.brandColor) || "#1a1816";
  const brandText = pickReadableTextColor(brand);
  const orgName = escapeHtml(branding.orgName);
  const logoBlock = branding.logoUrl
    ? `<img src="${escapeAttr(branding.logoUrl)}" alt="${orgName}" style="display:block;max-height:48px;max-width:200px;border:0;outline:none;text-decoration:none" />`
    : `<span style="font-family:Georgia,serif;font-size:24px;color:#1a1816">${orgName}</span>`;

  // Multi-button mode wins when provided. Each button gets its own
  // inner <td> so Outlook 2016 renders the rounded corners reliably.
  // A spacer <td> between buttons gives horizontal gap that doesn't
  // collapse during email-client rendering.
  const multiButtonBlock =
    ctaButtons && ctaButtons.length > 0
      ? `
        <tr>
          <td style="padding:8px 32px 24px" align="left">
            <table role="presentation" cellspacing="0" cellpadding="0" border="0">
              <tr>
                ${ctaButtons
                  .map((btn, i) => {
                    const isPrimary = i === 0;
                    const cellBg = isPrimary ? `background:${brand};` : "";
                    const cellBorder = isPrimary
                      ? ""
                      : `border:1px solid ${brand};`;
                    const linkColor = isPrimary ? brandText : brand;
                    const arrow = isPrimary ? " &rarr;" : "";
                    const spacer =
                      i < ctaButtons.length - 1
                        ? `<td style="width:12px;font-size:0;line-height:0">&nbsp;</td>`
                        : "";
                    return `
                      <td style="border-radius:6px;${cellBg}${cellBorder}">
                        <a href="${escapeAttr(btn.url)}"
                           style="display:inline-block;padding:12px 24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:15px;font-weight:600;color:${linkColor};text-decoration:none">
                          ${escapeHtml(btn.label)}${arrow}
                        </a>
                      </td>${spacer}`;
                  })
                  .join("")}
              </tr>
            </table>
          </td>
        </tr>`
      : "";

  // Legacy single-CTA block — only rendered when multi-button mode is
  // NOT active. This is the path all 10 transactional email types use.
  const singleCtaBlock =
    !multiButtonBlock && ctaLabel && ctaUrl
      ? `
        <tr>
          <td style="padding:8px 32px 24px" align="left">
            <table role="presentation" cellspacing="0" cellpadding="0" border="0">
              <tr>
                <td style="border-radius:6px;background:${brand}">
                  <a href="${escapeAttr(ctaUrl)}"
                     style="display:inline-block;padding:12px 24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:15px;font-weight:600;color:${brandText};text-decoration:none">
                    ${escapeHtml(ctaLabel)} &rarr;
                  </a>
                </td>
              </tr>
            </table>
          </td>
        </tr>`
      : "";

  const ctaBlock = multiButtonBlock || singleCtaBlock;

  const footer = branding.footerText
    ? `<div style="font-size:12px;color:#6b6661;line-height:1.5">${escapeHtmlAllowingBreaks(branding.footerText)}</div>`
    : `<div style="font-size:12px;color:#6b6661">Sent by ${orgName}</div>`;

  return stripTrailingWhitespace(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background:#f3eee6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1a1816">
  <span style="display:none;font-size:1px;color:#f3eee6;max-height:0;max-width:0;overflow:hidden">
    ${escapeHtml(subject)}
  </span>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f3eee6;padding:24px 0">
    <tr>
      <td align="center">
        <table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.04)">
          <tr>
            <td style="padding:24px 32px;border-bottom:1px solid #e8e3dc">
              ${logoBlock}
            </td>
          </tr>
          <tr>
            <td style="padding:24px 32px 8px;font-size:15px;line-height:1.55;color:#1a1816">
              ${bodyHtml}
            </td>
          </tr>
          ${ctaBlock}
          <tr>
            <td style="padding:16px 32px 24px;border-top:1px solid #e8e3dc;background:#faf8f4">
              ${footer}
            </td>
          </tr>
        </table>
        <div style="padding:16px;font-size:11px;color:#6b6661">
          You're receiving this because you're a member of ${orgName}.
        </div>
      </td>
    </tr>
  </table>
</body>
</html>`);
}

function sanitizeHex(s: string | null | undefined): string | null {
  if (!s) return null;
  const m = s.trim().match(/^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/);
  if (!m) return null;
  const v = m[1].length === 3 ? m[1].split("").map((c) => c + c).join("") : m[1];
  return "#" + v.toLowerCase();
}

function pickReadableTextColor(hex: string): string {
  // Calculate luminance — return white text on dark bg, black on light.
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return lum > 0.55 ? "#1a1816" : "#ffffff";
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
function escapeAttr(s: string): string {
  return escapeHtml(s);
}
function escapeHtmlAllowingBreaks(s: string): string {
  // Escapes HTML but turns \n into <br> so multi-line footers render.
  return escapeHtml(s).replace(/\n/g, "<br>");
}

/**
 * Strip trailing spaces/tabs on every line of the rendered HTML.
 *
 * Quoted-printable encoding (used by most SMTP transports when bodies
 * exceed 998 chars per line) turns trailing whitespace into literal
 * `=20` on the wire. Modern email clients decode this back to spaces,
 * but some corporate / older clients render the raw `=20` to the user
 * — see ticket #165. Stripping at render time fixes the common case
 * for zero perf cost; if the renderer added trailing whitespace to a
 * pre formatted block it would matter, but it doesn't.
 */
function stripTrailingWhitespace(html: string): string {
  return html
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n");
}
