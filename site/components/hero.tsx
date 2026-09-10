import { ArrowDown, ArrowUpRight, Play } from 'lucide-react';
import { LivingTank } from './living-tank';
export function Hero() {
  return (
    <section className="hero" aria-labelledby="hero-title">
      <div className="hero-grain" aria-hidden="true" />
      <div className="container hero-content">
        <a className="release-note" href="#get-started">
          <span className="status-dot" /> A little agent. A whole computer.{' '}
          <span className="release-version">
            v0.1.0 <ArrowUpRight size={12} />
          </span>
        </a>
        <h1 id="hero-title">
          Give your AI
          <br />
          its <em>own computer.</em>
        </h1>
        <p className="hero-description">
          The open-source agent with a desktop of its own.
          <br className="desktop-break" /> Tell it what you need. Watch it work
          through the glass.
        </p>
        <div className="hero-actions">
          <a className="button button-dark" href="#get-started">
            Meet your Deskfish <ArrowUpRight size={18} />
          </a>
          <a className="button button-light" href="#demo">
            <Play size={14} fill="currentColor" /> Watch it work{' '}
            <span className="button-time">3 films</span>
          </a>
        </div>
        <div className="hero-footnote">
          <span>Runs locally</span>
          <i />
          <span>Bring your own model</span>
          <i />
          <span>Apache 2.0</span>
        </div>
        <div className="tank-showcase">
          <div className="tank-annotation">
            <span>their little world,</span>
            <span>right next to yours.</span>
            <ArrowDown size={28} />
          </div>
          <LivingTank />
        </div>
      </div>
    </section>
  );
}
