import { SiteHeader } from '@/components/site-header';
import { Hero } from '@/components/hero';
import { WindowsSection } from '@/components/windows';
import { ContinuitySection, RhythmSection } from '@/components/continuity';
import {
  ProductIntro,
  TaskExplorer,
  HandoffSection,
  DetailsSection,
  ModelSection,
  FilmSection,
  FaqSection,
  GetStarted,
  SiteFooter,
  RevealObserver,
} from '@/components/experience';
export default function Home() {
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <SiteHeader />
      <main id="main">
        <Hero />
        <ProductIntro />
        <WindowsSection />
        <TaskExplorer />
        <HandoffSection />
        <DetailsSection />
        <ContinuitySection />
        <RhythmSection />
        <ModelSection />
        <FilmSection />
        <FaqSection />
        <GetStarted />
      </main>
      <SiteFooter />
      <RevealObserver />
    </>
  );
}
