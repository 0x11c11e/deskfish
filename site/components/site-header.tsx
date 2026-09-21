'use client';
import { useState } from 'react';
import { ArrowUpRight, Menu, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Brand } from './brand';
import { ThemeSwitch } from './theme-switch';
export function SiteHeader() {
  const [open, setOpen] = useState(false);
  return (
    <header className="site-header">
      <div className="nav-inner">
        <Brand />
        <nav
          className={open ? 'main-nav is-open' : 'main-nav'}
          id="main-nav"
          aria-label="Main navigation"
        >
          <a href="/#ways-in" onClick={() => setOpen(false)}>
            Meet Deskfish
          </a>
          <a href="/#possibilities" onClick={() => setOpen(false)}>
            What it can do
          </a>
          <a href="/docs/" onClick={() => setOpen(false)}>
            Documentation
          </a>
          <a
            className="nav-source"
            href="https://github.com/0x11c11e/deskfish"
            target="_blank"
            rel="noopener"
            onClick={() => setOpen(false)}
          >
            Source code on GitHub <ArrowUpRight size={13} />
          </a>
        </nav>
        <div className="nav-actions">
          <a
            className="nav-github"
            href="https://github.com/0x11c11e/deskfish"
            target="_blank"
            rel="noopener"
            aria-label="Source code on GitHub"
            title="Source code on GitHub"
          >
            <GitHubMark />
          </a>
          <ThemeSwitch />
          <a className="nav-cta" href="/#get-started">
            Get Deskfish <ArrowUpRight size={16} />
          </a>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="menu-toggle"
          aria-label={open ? 'Close navigation' : 'Open navigation'}
          aria-controls="main-nav"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {open ? <X /> : <Menu />}
        </Button>
      </div>
    </header>
  );
}

function GitHubMark() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" fill="currentColor">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}
