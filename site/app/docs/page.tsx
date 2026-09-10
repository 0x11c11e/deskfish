import type { Metadata } from 'next';
import {
  ArrowUpRight,
  ArrowRight,
  Waves,
  SlidersHorizontal,
  BookOpen,
  LifeBuoy,
} from 'lucide-react';
import { DocsShell } from '@/components/docs-shell';
import pages from '@/app/content/docs.json';
export const metadata: Metadata = {
  title: 'The field guide — Deskfish',
  description:
    'The Deskfish field guide for everyday use: setup, models, files, memory, reflection, playbooks, schedules, and life in the tank.',
  alternates: { canonical: '/docs/' },
  twitter: {
    card: 'summary',
    title: 'The field guide — Deskfish',
    description: 'Get to know your little desktop agent.',
    images: [],
  },
  openGraph: {
    title: 'The field guide — Deskfish',
    description: 'Get to know your little desktop agent.',
    url: '/docs/',
    images: [],
  },
};
const groups = [
  {
    title: 'Start here',
    Icon: Waves,
    description: 'A home for your new coworker.',
  },
  {
    title: 'Using Deskfish',
    Icon: BookOpen,
    description: 'Everyday life on the other side of the glass.',
  },
  {
    title: 'Under the hood',
    Icon: SlidersHorizontal,
    description: 'See what makes the little fish tick.',
  },
  {
    title: 'Reference',
    Icon: SlidersHorizontal,
    description: 'The details, when you need them.',
  },
  {
    title: 'Help',
    Icon: LifeBuoy,
    description: 'A hand when something gets in the way.',
  },
];
export default function DocsHome() {
  return (
    <DocsShell>
      <div className="docs-eyebrow">THE DESKFISH FIELD GUIDE</div>
      <h1>
        A little reading.
        <br />
        <em>A whole new world.</em>
      </h1>
      <p className="docs-lede">
        Make yourself at home. From your first task to the last configuration
        detail, here’s how life in the tank works.
      </p>
      <a className="docs-start-card" href="/docs/getting-started/">
        <span>
          <span className="eyebrow">YOUR FIRST TEN MINUTES</span>
          <strong>Let’s get your fish settled in.</strong>
          <span>Install the extension, pick a model, turn on the tank.</span>
        </span>
        <ArrowUpRight size={24} />
      </a>
      <div className="docs-overview">
        {groups.map(({ title, Icon, description }) => (
          <section key={title}>
            <div className="docs-group-title">
              <Icon size={19} />
              <h2>{title}</h2>
            </div>
            <p>{description}</p>
            <div>
              {pages
                .filter((p) => p.section === title)
                .map((page) => (
                  <a href={`/docs/${page.slug}/`} key={page.slug}>
                    {page.title}
                    <ArrowRight size={14} />
                  </a>
                ))}
            </div>
          </section>
        ))}
      </div>
    </DocsShell>
  );
}
