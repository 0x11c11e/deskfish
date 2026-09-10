'use client';
import { useEffect, useRef, useState } from 'react';
export function DocsArticle({ html }: { html: string }) {
  const article = useRef<HTMLDivElement>(null);
  const [announcement, setAnnouncement] = useState('');
  useEffect(() => {
    const buttons =
      article.current?.querySelectorAll<HTMLButtonElement>('button.copy');
    async function copy(event: Event) {
      const button = event.currentTarget as HTMLButtonElement;
      const code = button.closest('figure')?.querySelector('code');
      if (!code) return;
      try {
        await navigator.clipboard.writeText(code.textContent ?? '');
        button.textContent = 'Copied!';
        setAnnouncement('Code copied to clipboard.');
      } catch {
        const range = document.createRange();
        range.selectNodeContents(code);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        button.textContent = 'Code selected';
        setAnnouncement('Code selected. Use your keyboard’s copy shortcut.');
      }
    }
    buttons?.forEach((button) => button.addEventListener('click', copy));
    return () =>
      buttons?.forEach((button) => button.removeEventListener('click', copy));
  }, [html]);
  return (
    <>
      <div
        ref={article}
        className="docs-article"
        dangerouslySetInnerHTML={{ __html: html }}
      />
      <output className="sr-only">{announcement}</output>
    </>
  );
}
