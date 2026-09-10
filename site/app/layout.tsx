import type { Metadata } from 'next';
import './globals.css';
import './themes.css';
import './bubbles.css';
import { BackgroundBubbles } from '@/components/background-bubbles';
import { THEME_BOOTSTRAP } from '@/lib/theme';

export const metadata: Metadata = {
  metadataBase: new URL('https://deskfish.sh'),
  alternates: { canonical: '/' },
  title: 'Deskfish — Give your AI its own computer',
  description:
    'An open-source desktop agent in VS Code, with its own Linux computer, memory, playbooks, and scheduled tasks. Watch it work. Bring your own model.',
  icons: { icon: '/assets/logo.svg', apple: '/assets/icon.png' },
  openGraph: {
    title: 'Deskfish — Give your AI its own computer',
    description:
      'Watch it work through the glass. Its own computer, a little history, and a rhythm for recurring work. Open source. Your choice of model.',
    type: 'website',
    url: 'https://deskfish.sh',
    siteName: 'Deskfish',
    images: [
      {
        url: '/og.png',
        width: 1280,
        height: 800,
        alt: 'The Deskfish Linux desktop with its fish-in-a-monitor wallpaper.',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Deskfish — Give your AI its own computer',
    description:
      'Its own computer, memory, playbooks, and scheduled tasks. Open source. Your choice of model.',
    images: ['/og.png'],
  },
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
        <link
          rel="preload"
          href="/fonts/sans.ttf"
          as="font"
          type="font/ttf"
          crossOrigin="anonymous"
        />
        <link
          rel="preload"
          href="/fonts/serif.ttf"
          as="font"
          type="font/ttf"
          crossOrigin="anonymous"
        />
      </head>
      <body>
        <BackgroundBubbles />
        {children}
      </body>
    </html>
  );
}
