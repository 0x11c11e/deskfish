import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { DocsArticle } from '@/components/docs-article';
import { DocsShell } from '@/components/docs-shell';
import pages from '@/app/content/docs.json';
export function generateStaticParams() {
  return pages.map((p) => ({ slug: p.slug }));
}
export const dynamicParams = false;
type Props = { params: Promise<{ slug: string }> };
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const page = pages.find((p) => p.slug === slug);
  if (!page) return {};
  return {
    title: `${page.title} — Deskfish field guide`,
    description: page.description,
    alternates: { canonical: `/docs/${page.slug}/` },
    twitter: {
      card: 'summary',
      title: `${page.title} — Deskfish`,
      description: page.description,
      images: [],
    },
    openGraph: {
      title: `${page.title} — Deskfish`,
      description: page.description,
      url: `/docs/${page.slug}/`,
      images: [],
    },
  };
}
export default async function DocPage({ params }: Props) {
  const { slug } = await params;
  const page = pages.find((p) => p.slug === slug);
  if (!page) notFound();
  return (
    <DocsShell current={page.slug}>
      <div className="docs-eyebrow">
        <a href="/docs/">Field guide</a>
        <span>/</span>
        {page.section}
      </div>
      <h1>{page.title}</h1>
      <p className="docs-lede">{page.description}</p>
      <DocsArticle html={page.html} />
    </DocsShell>
  );
}
