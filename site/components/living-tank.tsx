'use client';
import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from 'react';
import {
  ArrowRight,
  ArrowUpRight,
  Brain,
  Check,
  CheckCheck,
  ChevronRight,
  CircleCheck,
  Globe2,
  Hand,
  LockKeyhole,
  Monitor,
  MousePointer2,
  Pause,
  Play,
  RotateCcw,
  Search,
  ShoppingBag,
  Terminal,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DEMO_TASK,
  REPLAY_DURATION,
  STILL_SCENES,
  getReplayFrame,
} from '@/lib/tank-replay';
import './living-tank.css';

function subscribeToMotion(notify: () => void) {
  const media = window.matchMedia('(prefers-reduced-motion: reduce)');
  media.addEventListener('change', notify);
  return () => media.removeEventListener('change', notify);
}
function prefersReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
function subscribeToVisibility(notify: () => void) {
  document.addEventListener('visibilitychange', notify);
  return () => document.removeEventListener('visibilitychange', notify);
}
function pageVisible() {
  return !document.hidden;
}
const serverFalse = () => false;
const serverTrue = () => true;

export function LivingTank() {
  const [elapsed, setElapsed] = useState(0);
  const [paused, setPaused] = useState(false);
  const [inView, setInView] = useState(false);
  const [stillScene, setStillScene] = useState(3);
  const root = useRef<HTMLDivElement>(null);
  const clock = useRef(0);
  const surface = useRef<HTMLDivElement>(null);
  const pointer = useRef<HTMLDivElement>(null);
  const reduced = useSyncExternalStore(
    subscribeToMotion,
    prefersReducedMotion,
    serverFalse,
  );
  const visible = useSyncExternalStore(
    subscribeToVisibility,
    pageVisible,
    serverTrue,
  );
  const playing = !paused && !reduced && inView && visible;

  useEffect(() => {
    if (!root.current) return;
    if (!('IntersectionObserver' in window)) {
      const timer = setTimeout(() => setInView(true), 0);
      return () => clearTimeout(timer);
    }
    const observer = new IntersectionObserver(
      ([entry]) => setInView(entry.isIntersecting),
      { threshold: 0 }, // play whenever any of it is on screen; a half-visible, frozen replay looks broken
    );
    observer.observe(root.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!playing) return;
    let request = 0;
    let previous = performance.now();
    let rendered = previous;
    function tick(now: number) {
      clock.current =
        (clock.current + Math.min(now - previous, 100)) % REPLAY_DURATION;
      previous = now;
      if (now - rendered >= 45) {
        setElapsed(clock.current);
        rendered = now;
      }
      request = requestAnimationFrame(tick);
    }
    request = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(request);
  }, [playing]);

  function replay() {
    clock.current = 0;
    setElapsed(0);
    setStillScene(0);
    setPaused(false);
  }
  const frame = getReplayFrame(reduced ? STILL_SCENES[stillScene] : elapsed);
  // Aim at the actual rendered controls, so the clicks stay aligned at every width.
  useEffect(() => {
    const desktop = surface.current;
    const cursor = pointer.current;
    if (!desktop || !cursor) return;
    function placeCursor() {
      if (!desktop || !cursor) return;
      const target = desktop.querySelector<HTMLElement>(
        `[data-cursor-target="${frame.pointer.target}"]`,
      );
      if (!target) {
        cursor.style.setProperty('--cursor-x', `${frame.pointer.x}%`);
        cursor.style.setProperty('--cursor-y', `${frame.pointer.y}%`);
        return;
      }
      const box = desktop.getBoundingClientRect();
      const rect = target.getBoundingClientRect();
      cursor.style.setProperty(
        '--cursor-x',
        `${rect.left - box.left + rect.width / 2 - 5}px`,
      );
      cursor.style.setProperty(
        '--cursor-y',
        `${rect.top - box.top + rect.height / 2 - 3}px`,
      );
    }
    placeCursor();
    const observer = new ResizeObserver(placeCursor);
    observer.observe(desktop);
    return () => observer.disconnect();
  }, [
    frame.pointer.target,
    frame.pointer.x,
    frame.pointer.y,
    frame.page,
    frame.browserOpen,
  ]);
  const mobileText = !frame.sent
    ? frame.typedTask || 'Give your fish a task…'
    : frame.handoff
      ? 'Deskfish needs you. Step in for the final click.'
      : frame.reply || DEMO_TASK;
  return (
    <div
      ref={root}
      className="living-tank"
      data-playing={playing}
      data-human={frame.human}
      data-handoff={frame.handoff}
    >
      <section
        className="editor-window living-window"
        aria-label="Scripted replay of Deskfish buying its domain"
      >
        <div className="editor-titlebar">
          <div className="window-dots">
            <i />
            <i />
            <i />
          </div>
          <span>
            deskfish <span className="titlebar-separator">—</span> Visual Studio
            Code
          </span>
          <Monitor size={14} />
        </div>
        <div className="living-body">
          <aside className="living-sidebar" aria-label="Demo conversation">
            <div className="living-sidebar-heading">
              <img src="/assets/logo.svg" width="21" height="21" alt="" />
              <span>DESKFISH: CHAT</span>
              <span className="living-ellipsis">···</span>
            </div>
            <div className="living-settings">
              <div>
                <span>Desktop</span>
                <strong>
                  <i className="status-dot" /> On
                </strong>
              </div>
              <div>
                <span>Model</span>
                <strong>Claude · Anthropic</strong>
              </div>
              <div>
                <span>API key</span>
                <strong>
                  <LockKeyhole size={10} /> Key saved
                </strong>
              </div>
            </div>
            <div className="living-chat">
              <div className="living-messages">
                {frame.sent && (
                  <div className="living-message living-user" key="task">
                    <span className="living-message-label">YOU</span>
                    {DEMO_TASK}
                  </div>
                )}
                {frame.reply && (
                  <div
                    className="living-message living-agent"
                    key={`reply-${frame.chapter}`}
                  >
                    <span className="living-message-label">
                      <img
                        src="/assets/logo.svg"
                        width="13"
                        height="13"
                        alt=""
                      />{' '}
                      DESKFISH
                    </span>
                    {frame.reply}
                  </div>
                )}
                {frame.sent && !frame.handoff && !frame.complete && (
                  <div className="living-action-log">
                    <ChevronRight size={10} />
                    {frame.actionCount} actions <span>· look, think, act</span>
                  </div>
                )}
                {frame.handoff && (
                  <div className="living-message living-knock-card">
                    <Hand size={15} />
                    <strong>Deskfish needs you.</strong>
                    <p>
                      {frame.page === 'complete'
                        ? 'Done. Time to hand the desktop back.'
                        : 'The order is ready. Your turn for the final click.'}
                    </p>
                    <span>
                      {frame.human
                        ? 'You have the desktop'
                        : 'Knocking on the glass…'}
                      <ArrowUpRight size={12} />
                    </span>
                  </div>
                )}
                {frame.memory && (
                  <div className="living-memory">
                    <Brain size={13} />
                    <span>Remembered: my domain is deskfish.sh.</span>
                  </div>
                )}
                {frame.complete && (
                  <div className="living-finished">
                    <CheckCheck size={14} /> Task finished
                  </div>
                )}
              </div>
            </div>
            <div className="living-composer">
              <div className="living-status">
                {frame.complete ? (
                  <CircleCheck size={12} />
                ) : frame.handoff ? (
                  <Hand size={12} />
                ) : frame.sent ? (
                  <span className="small-spinner" />
                ) : (
                  <i className="status-dot" />
                )}
                <span>{frame.status}</span>
              </div>
              <div className="living-input">
                {!frame.sent ? (
                  <>
                    {frame.typedTask}
                    <i className="living-caret" />
                  </>
                ) : (
                  <span>Give your fish another task…</span>
                )}
              </div>
              <div
                className={`living-send ${frame.sending ? 'is-sending' : ''}`}
              >
                <ArrowRight size={12} /> Run
              </div>
            </div>
          </aside>
          <div className="living-desktop">
            <div className="living-desktop-tab">
              <Monitor size={12} />
              <span>Deskfish — Desktop</span>
              <span className="living-replay-label">SCRIPTED REPLAY</span>
            </div>
            <div className="living-toolbar">
              <span className="living-connection">
                <i className="status-dot" /> Desktop on
              </span>
              <span className="living-agent-pill">
                {frame.complete
                  ? 'Task complete'
                  : frame.handoff
                    ? 'Agent paused'
                    : frame.sent
                      ? 'Agent working'
                      : 'Ready'}
              </span>
              <span className="living-owner">
                {frame.human ? (
                  <>
                    <MousePointer2 size={11} /> Your turn
                  </>
                ) : (
                  <>
                    <Monitor size={11} /> Its own computer
                  </>
                )}
              </span>
            </div>
            <div className="living-surface" ref={surface}>
              <div className="living-wallpaper" aria-hidden="true">
                <img
                  src="/assets/tank-wallpaper.svg"
                  alt=""
                  width="1280"
                  height="800"
                />
              </div>
              <div className="living-browser" data-open={frame.browserOpen}>
                <div className="living-browser-chrome">
                  <div className="living-browser-dots">
                    <i />
                    <i />
                    <i />
                  </div>
                  <div className="living-url" data-cursor-target="address">
                    <LockKeyhole size={10} />
                    <span>
                      {frame.url}
                      {frame.time >= 7_000 && frame.time < 8_200 && (
                        <i className="living-caret" />
                      )}
                    </span>
                  </div>
                </div>
                <div className="living-webpage" key={frame.page}>
                  {frame.page === 'blank' && (
                    <div className="living-loading">
                      <span className="small-spinner" />
                      <span>Opening the browser…</span>
                    </div>
                  )}
                  {frame.page === 'search' && (
                    <>
                      <div className="living-site-brand">
                        <span className="living-namecheap">namecheap</span>
                        <span>Domain search</span>
                      </div>
                      <div className="living-search-content">
                        <span className="living-web-eyebrow">
                          DOMAIN REGISTRATION
                        </span>
                        <h3>Find your new domain</h3>
                        <div className="living-search-box">
                          <Search size={15} />
                          <span data-cursor-target="search-input">
                            {frame.query || (
                              <span className="living-placeholder">
                                Find your domain
                              </span>
                            )}
                            {frame.time >= 9_500 && frame.time < 10_700 && (
                              <i className="living-caret" />
                            )}
                          </span>
                          <span
                            className="living-search-submit"
                            data-cursor-target="search-button"
                          >
                            Search <ArrowRight size={13} />
                          </span>
                        </div>
                      </div>
                    </>
                  )}
                  {frame.page === 'results' && (
                    <>
                      <div className="living-site-brand">
                        <span className="living-namecheap">namecheap</span>
                        <span>Search results</span>
                      </div>
                      <div className="living-result-content">
                        <span className="living-web-eyebrow">
                          RESULTS FOR YOUR SEARCH
                        </span>
                        <h3>
                          deskfish<span>.sh</span>
                        </h3>
                        <div className="living-result-state">
                          <CircleCheck size={13} /> Found in our recorded task
                        </div>
                        <div className="living-order-line">
                          <span>Registration</span>
                          <strong>One year</strong>
                        </div>
                        <div className="living-cart-action">
                          <span>No add-ons selected</span>
                          <span
                            className="living-demo-button"
                            data-cursor-target="add-cart"
                          >
                            <ShoppingBag size={12} /> Add to cart
                          </span>
                        </div>
                      </div>
                    </>
                  )}
                  {frame.page === 'checkout' && (
                    <>
                      <div className="living-site-brand">
                        <span className="living-namecheap">namecheap</span>
                        <span>Checkout</span>
                      </div>
                      <div className="living-checkout-content">
                        <span className="living-web-eyebrow">
                          CONFIRM YOUR ORDER
                        </span>
                        <h3>Order review</h3>
                        <div className="living-order-line">
                          <strong>deskfish.sh</strong>
                          <span>1 year</span>
                        </div>
                        <div className="living-order-line">
                          <span>Add-ons</span>
                          <span>None</span>
                        </div>
                        <div className="living-checkout-action">
                          <span>
                            <LockKeyhole size={12} /> Ready for your review
                          </span>
                          <span
                            data-cursor-target="pay"
                            className={`living-demo-button ${frame.handoff ? 'is-waiting' : ''}`}
                          >
                            Pay now <ArrowRight size={13} />
                          </span>
                        </div>
                        <span className="living-purchase-note">
                          Illustration only — no purchase is made.
                        </span>
                      </div>
                    </>
                  )}
                  {frame.page === 'complete' && (
                    <div className="living-success">
                      <span className="living-success-icon">
                        <Check size={25} />
                      </span>
                      <span className="living-web-eyebrow">
                        ORDER CONFIRMATION
                      </span>
                      <h3>Thank you for your purchase!</h3>
                      <p>Your domain registration is confirmed.</p>
                      <div className="living-success-receipt">
                        <Globe2 size={15} />
                        <span>
                          deskfish.sh <small>One year · no add-ons</small>
                        </span>
                        <CircleCheck size={16} />
                      </div>
                    </div>
                  )}
                </div>
              </div>
              {frame.handoff && !frame.human && (
                <div className="living-glass-knock" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </div>
              )}
              <div
                className="living-cursor"
                ref={pointer}
                aria-hidden="true"
                style={
                  {
                    '--cursor-x': `${frame.pointer.x}%`,
                    '--cursor-y': `${frame.pointer.y}%`,
                  } as CSSProperties
                }
              >
                <MousePointer2 size={22} fill="currentColor" />
                {frame.click !== undefined && (
                  <i key={frame.click} className="living-click-ring" />
                )}
                <span>{frame.human ? 'You' : 'Deskfish'}</span>
              </div>
              <div className="living-dock">
                <span
                  className="living-firefox-icon"
                  data-cursor-target="firefox"
                  aria-hidden="true"
                />
                <Terminal size={16} />
                <i />
                {frame.browserOpen && <span>Firefox</span>}
              </div>
            </div>
            <div className="living-mobile-story">
              <span>
                {!frame.sent ? 'YOU' : frame.handoff ? 'YOUR TURN' : 'DESKFISH'}
              </span>
              <p>{mobileText}</p>
            </div>
            <div className="living-desktop-status">
              <span>
                <i className="status-dot" /> {frame.status}
              </span>
              <span>Linux · sandboxed</span>
            </div>
          </div>
        </div>
        <div className="living-progress" aria-hidden="true">
          <span style={{ width: `${(frame.time / REPLAY_DURATION) * 100}%` }} />
        </div>
      </section>
      <div className="living-caption">
        <div className="living-chapter">
          <span>0{frame.chapter + 1} / 05</span>
          <span>{frame.title}</span>
        </div>
        <div className="living-controls">
          <Button
            variant="ghost"
            className="living-control"
            onClick={() =>
              reduced
                ? setStillScene((stillScene + 1) % STILL_SCENES.length)
                : setPaused(!paused)
            }
            aria-label={
              reduced
                ? 'Show next demo scene'
                : paused
                  ? 'Play desktop demo'
                  : 'Pause desktop demo'
            }
          >
            {reduced ? (
              <ChevronRight size={13} />
            ) : paused ? (
              <Play size={13} />
            ) : (
              <Pause size={13} />
            )}
            <span>{reduced ? 'Next scene' : paused ? 'Play' : 'Pause'}</span>
          </Button>
          <Button
            variant="ghost"
            className="living-control"
            onClick={replay}
            aria-label="Replay desktop demo"
          >
            <RotateCcw size={13} />
            <span>Replay</span>
          </Button>
        </div>
      </div>
      <p className="living-disclosure">
        A scripted replay of our first errand.{' '}
        <a href="#demo">
          Watch the real recording <ArrowUpRight size={11} />
        </a>
      </p>
    </div>
  );
}
