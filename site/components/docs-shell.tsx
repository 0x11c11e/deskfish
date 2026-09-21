import type { ReactNode } from 'react';
import { ArrowLeft, ArrowRight, ArrowUpRight } from 'lucide-react';
import { SiteHeader } from '@/components/site-header';
import { DocsNavigation } from '@/components/docs-navigation';
import pages from '@/app/content/docs.json';
const entries = pages.map(
  ({ slug, title, description, section, headings }) => ({
    slug,
    title,
    description,
    section,
    headings,
  }),
);
export function DocsShell({
  current,
  children,
}: {
  current?: string;
  children: ReactNode;
}) {
  const index = pages.findIndex((p) => p.slug === current);
  const page = pages[index];
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <SiteHeader />
      <div className="docs-layout">
        <DocsNavigation entries={entries} current={current} />
        <main className="docs-main" id="main">
          {children}
          {page && (
            <nav
              className="docs-pagination"
              aria-label="Previous and next guides"
            >
              {index > 0 ? (
                <a href={`/docs/${pages[index - 1].slug}/`}>
                  <span>
                    <ArrowLeft size={13} /> Previous
                  </span>
                  {pages[index - 1].title}
                </a>
              ) : (
                <span />
              )}
              {index < pages.length - 1 && (
                <a href={`/docs/${pages[index + 1].slug}/`}>
                  <span>
                    Up next <ArrowRight size={13} />
                  </span>
                  {pages[index + 1].title}
                </a>
              )}
            </nav>
          )}
          <div className="docs-bottom">
            <span>Deskfish field guide · Apache 2.0</span>
            <a href="/">
              Back to the little fish <ArrowUpRight size={13} />
            </a>
          </div>
        </main>
        <aside className="docs-toc">
          {page && (
            <nav aria-label="On this page">
              <span>ON THIS PAGE</span>
              {page.headings
                .filter((h) => h.level === 2)
                .map((h) => (
                  <a key={h.id} href={`#${h.id}`}>
                    {h.text}
                  </a>
                ))}
              <a className="toc-help" href="/docs/troubleshooting/">
                Need a hand? <ArrowUpRight size={13} />
              </a>
            </nav>
          )}
        </aside>
      </div>
    </>
  );
}
