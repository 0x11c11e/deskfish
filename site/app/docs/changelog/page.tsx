import type { Metadata } from 'next';
import { DocsShell } from '@/components/docs-shell';
import { releases, version, releaseDate } from '@/lib/docs-pages';
import './changelog.css';
const description = 'What changed in each release of Deskfish, newest first.';
export const metadata: Metadata = {
  title: 'Changelog — Deskfish field guide',
  description,
  alternates: { canonical: '/docs/changelog/' },
  twitter: {
    card: 'summary',
    title: 'Changelog — Deskfish',
    description,
    images: [],
  },
  openGraph: {
    title: 'Changelog — Deskfish',
    description,
    url: '/docs/changelog/',
    images: [],
  },
};
/** A commit subject is plain text; `backticks` become code, nothing else is markup. */
function Line({ text }: { text: string }) {
  return text
    .split('`')
    .map((part, i) => (i % 2 ? <code key={i}>{part}</code> : part));
}
export default function Changelog() {
  return (
    <DocsShell current="changelog">
      <div className="docs-eyebrow">
        <a href="/docs/">Field guide</a>
        <span>/</span>
        Reference
      </div>
      <h1>Changelog</h1>
      <p className="docs-lede">{description}</p>
      <div className="docs-article changelog">
        <p>
          This page is generated from the{' '}
          <a href="https://github.com/0x11c11e/deskfish/releases">
            GitHub releases
          </a>{' '}
          of Deskfish.
        </p>
        {releases.map((release) => (
          <section className="changelog-release" key={release.tag_name}>
            <div className="changelog-label">
              <h2 id={release.tag_name}>
                <a href={release.html_url}>
                  <code>{version(release.tag_name)}</code>
                </a>
              </h2>
              <time dateTime={release.published_at}>
                {releaseDate(release.published_at)}
              </time>
            </div>
            <ul>
              {release.changes.map((change, i) => (
                <li key={i}>
                  <Line text={change} />
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </DocsShell>
  );
}
