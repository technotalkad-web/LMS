/**
 * Journey icon renderer. `journey_programs.icon` is text holding either an
 * emoji ("🏹") or, since the icon-upload feature, the public URL of a small
 * uploaded logo. Render sites all funnel through here so both forms work
 * everywhere (dashboard banner, journey page, admin pills, certificate).
 *
 * The image is sized in em so it scales with the surrounding text exactly
 * like an emoji glyph would.
 */

export function isIconUrl(icon: string | null | undefined): boolean {
  return !!icon && /^(https?:\/\/|\/)/.test(icon.trim());
}

export function JourneyIcon({
  icon,
  className = "",
  imgSize = "h-[1.1em] w-[1.1em]",
}: {
  icon: string | null | undefined;
  className?: string;
  /** Tailwind size classes for the uploaded-logo form (replaces the em default). */
  imgSize?: string;
}) {
  if (!icon) return null;
  if (isIconUrl(icon)) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={icon}
        alt=""
        className={`inline-block object-contain align-[-0.15em] ${imgSize} ${className}`}
      />
    );
  }
  return <span className={className}>{icon}</span>;
}
