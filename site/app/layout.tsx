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
    'An open-source agent with its own computer, memory, and scheduled tasks. Use the desktop app, your browser, or VS Code. Your machine. Your choice of model.',
  icons: { icon: '/assets/logo.svg', apple: '/assets/icon.png' },
  openGraph: {
    title: 'Deskfish — Give your AI its own computer',
    description:
      'One little world. Three ways in: the app, your browser, or VS Code. Its own computer and memory, on the machine you choose. Watch it work through the glass.',
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
      'Its own computer, memory, and scheduled tasks. A desktop app, a browser, or VS Code. Open source. Your choice of model.',
    images: ['/og.png'],
  },
};
// Google Analytics, on only when the Measurement ID is set at build time (Vercel → Settings →
// Environment Variables → NEXT_PUBLIC_GA_ID, e.g. G-XXXXXXXXXX). Nothing is loaded without it.
const GA_ID = process.env.NEXT_PUBLIC_GA_ID ?? '';

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
        {GA_ID ? (
          <>
            <script
              async
              src={`https://www.googletagmanager.com/gtag/js?id=${GA_ID}`}
            />
            <script
              dangerouslySetInnerHTML={{
                __html: `window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}gtag('js',new Date());gtag('config','${GA_ID}');`,
              }}
            />
          </>
        ) : null}
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
