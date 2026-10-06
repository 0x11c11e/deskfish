import docs from '@/app/content/docs.json';
import releases from '@/app/content/changelog.json';

export type DocsPage = {
  slug: string;
  title: string;
  description: string;
  section: string;
  headings: { text: string; id: string; level: number }[];
};

export { releases };
export const version = (tag: string) => tag.replace(/^v/, '');
export const releaseDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });

// The changelog is not a guide in docs/, so it joins the list here: last under Reference.
// "On this page" lists the newest twelve releases; the page itself shows them all.
const changelog: DocsPage = {
  slug: 'changelog',
  title: 'Changelog',
  description: 'What changed in each release of Deskfish, newest first.',
  section: 'Reference',
  headings: releases.slice(0, 12).map((r) => ({
    text: version(r.tag_name),
    id: r.tag_name,
    level: 2,
  })),
};
const guides: DocsPage[] = docs.map(
  ({ slug, title, description, section, headings }) => ({
    slug,
    title,
    description,
    section,
    headings,
  }),
);
const at = guides.map((p) => p.section).lastIndexOf('Reference') + 1;
export const docsPages = [
  ...guides.slice(0, at),
  changelog,
  ...guides.slice(at),
];
