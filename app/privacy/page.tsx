import type { Metadata } from "next";
import {
  PRIVACY_NOTICE_INTRO,
  PRIVACY_NOTICE_SECTIONS,
  PRIVACY_NOTICE_TITLE,
  PRIVACY_NOTICE_VERSION,
} from "./notice";

/**
 * The privacy notice (ADR 0034): a public page, linked from /login and from
 * every organisation's /<slug>/login. The middleware lets it through signed
 * out (an exact match on /privacy) and serves it unchanged on a white-label
 * host.
 *
 * The page reads nothing: no database, no session, no request data, no
 * browser code. All of its words live in ./notice; this file only lays them
 * out, so a change to the wording never touches it.
 */
export const metadata: Metadata = {
  title: PRIVACY_NOTICE_TITLE,
};

export default function PrivacyNoticePage() {
  return (
    <main className="min-h-screen bg-canvas text-ink px-4 py-12 sm:py-16">
      <article className="mx-auto w-full max-w-2xl">
        <header className="mb-8">
          <h1 className="serif text-4xl tracking-tight">{PRIVACY_NOTICE_TITLE}</h1>
          <p className="text-sm text-muted mt-2">{PRIVACY_NOTICE_VERSION}</p>
        </header>

        <div className="space-y-4 leading-relaxed">
          {PRIVACY_NOTICE_INTRO.map((p) => (
            <p key={p}>{p}</p>
          ))}
        </div>

        {PRIVACY_NOTICE_SECTIONS.map((section) => (
          <section key={section.heading} className="mt-10">
            <h2 className="serif text-2xl tracking-tight mb-3">{section.heading}</h2>
            <div className="space-y-3 leading-relaxed">
              {section.paragraphs?.map((p) => (
                <p key={p}>{p}</p>
              ))}
              {section.items && section.items.length > 0 && (
                <ul className="list-disc pl-6 space-y-2">
                  {section.items.map((item) => (
                    <li key={item.text}>
                      {item.lead && <span className="font-medium">{item.lead}</span>}
                      {item.lead && " "}
                      {item.text}
                    </li>
                  ))}
                </ul>
              )}
              {section.after?.map((p) => (
                <p key={p}>{p}</p>
              ))}
            </div>
          </section>
        ))}
      </article>
    </main>
  );
}
