'use client';
import { useEffect, useRef } from 'react';
export function DocsArticle({ html }: { html: string }) {
  const article = useRef<HTMLDivElement>(null);
  // A state update here replaces the rendered HTML and its attached copy handlers.
  const announcement = useRef<HTMLOutputElement>(null);
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
        if (announcement.current)
          announcement.current.textContent = 'Code copied to clipboard.';
      } catch {
        const range = document.createRange();
        range.selectNodeContents(code);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        button.textContent = 'Code selected';
        if (announcement.current)
          announcement.current.textContent =
            'Code selected. Use your keyboard’s copy shortcut.';
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
      <output ref={announcement} className="sr-only" />
    </>
  );
}
