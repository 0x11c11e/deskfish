'use client';
import { useState } from 'react';
import { Search, ArrowUpRight, BookOpen, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
type Entry = {
  slug: string;
  title: string;
  description: string;
  section: string;
  headings: { text: string; id: string; level: number }[];
};
export function DocsNavigation({
  entries,
  current,
}: {
  entries: Entry[];
  current?: string;
}) {
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState(false);
  const normalized = query.trim().toLowerCase();
  const matches = entries.filter((p) =>
    [p.title, p.description, ...p.headings.map((h) => h.text)]
      .join(' ')
      .toLowerCase()
      .includes(normalized),
  );
  const groups = [...new Set(entries.map((p) => p.section))];
  return (
    <aside className="docs-sidebar">
      <div className="docs-sidebar-heading">
        <a href="/docs/">
          <BookOpen size={16} /> Field guide
        </a>
        <Button
          className="docs-menu-toggle"
          variant="ghost"
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
          aria-controls="docs-navigation"
        >
          {expanded ? 'Close' : 'Browse'}
        </Button>
      </div>
      <div
        className={expanded ? 'docs-navigation expanded' : 'docs-navigation'}
        id="docs-navigation"
      >
        <div className="docs-search">
          <Search size={15} />
          <input
            aria-label="Search documentation"
            type="search"
            placeholder="Find your way…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {query && (
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Clear search"
              onClick={() => setQuery('')}
            >
              <X size={13} />
            </Button>
          )}
        </div>
        <nav aria-label="Documentation">
          {groups.map((group) => {
            const pages = matches.filter((p) => p.section === group);
            return pages.length ? (
              <div className="docs-nav-group" key={group}>
                <span>{group}</span>
                {pages.map((page) => (
                  <a
                    key={page.slug}
                    href={`/docs/${page.slug}/`}
                    aria-current={page.slug === current ? 'page' : undefined}
                  >
                    {page.title}
                  </a>
                ))}
              </div>
            ) : null;
          })}
        </nav>
        {normalized && (
          <output className="docs-search-status">
            {matches.length
              ? `${matches.length} ${matches.length === 1 ? 'guide' : 'guides'} found.`
              : 'No guides found. Try “model”, “files”, or “tank”.'}
          </output>
        )}
        <a className="docs-install-link" href="/#get-started">
          Give a fish a home <ArrowUpRight size={15} />
        </a>
      </div>
    </aside>
  );
}
