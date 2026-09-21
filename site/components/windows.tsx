'use client';

import {
  AppWindow,
  ArrowUpRight,
  Check,
  Code2,
  FileText,
  Globe2,
  History,
  Monitor,
  Plug,
  Server,
} from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import './windows.css';

const windows = [
  {
    id: 'app',
    label: 'The app',
    Icon: AppWindow,
    title: 'A little place on your desktop.',
    copy: 'Download Deskfish, open it, and give it a task. Close the window and it stays in the tray, working. When it needs you, a notification brings you back.',
    detail: 'For Linux, macOS, and Windows. No editor needed.',
    link: 'Get to know the app',
    href: '/docs/the-app/',
    chrome: 'Deskfish',
  },
  {
    id: 'browser',
    label: 'Your browser',
    Icon: Globe2,
    title: 'A window from wherever you are.',
    copy: 'Open the page served by your Deskfish. The chat, live desktop, history, settings, and schedules are all there. Sign in once with its token and pick up the same conversation.',
    detail: 'For another machine, connect through an SSH tunnel or Tailscale.',
    link: 'Open a window onto Deskfish',
    href: '/docs/running-without-vscode/',
    chrome: 'Your Deskfish · browser view',
  },
  {
    id: 'vscode',
    label: 'VS Code',
    Icon: Code2,
    title: 'Right beside the work you know.',
    copy: 'Keep the chat in your sidebar and its desktop in an editor tab. Give it an errand while you work. Closing or reloading VS Code leaves the task running in the background.',
    detail: 'Open the app alongside it. You are both looking at the same fish.',
    link: 'Set up the extension',
    href: '/docs/getting-started/#2-install-the-extension',
    chrome: 'Deskfish — Visual Studio Code',
  },
];

export function WindowsSection() {
  return (
    <section
      className="windows-section section container"
      id="ways-in"
      aria-labelledby="windows-title"
    >
      <div className="section-topline" data-reveal>
        <span className="eyebrow">
          <i /> 02 / MAKE YOURSELF AT HOME
        </span>
        <span className="side-note">
          Same fish. Same memory. A different window.
        </span>
      </div>
      <div className="section-heading" data-reveal>
        <h2 id="windows-title">
          Three windows.
          <br />
          <em>One little world.</em>
        </h2>
        <p>
          Deskfish lives on the machine you choose.
          <br />
          How you spend time with it is up to you.
        </p>
      </div>
      <Tabs defaultValue="app" className="windows-tabs" data-reveal>
        <TabsList
          className="windows-switch"
          aria-label="Choose a way to use Deskfish"
        >
          {windows.map(({ id, label, Icon }) => (
            <TabsTrigger key={id} value={id}>
              <Icon size={17} />
              {label}
            </TabsTrigger>
          ))}
        </TabsList>
        {windows.map((host) => (
          <TabsContent key={host.id} value={host.id} className="windows-panel">
            <div className="windows-copy">
              <span className="micro-label">
                YOUR WAY IN / {host.label.toUpperCase()}
              </span>
              <h3>{host.title}</h3>
              <p>{host.copy}</p>
              <p className="windows-detail">{host.detail}</p>
              <a className="text-link" href={host.href}>
                {host.link} <ArrowUpRight size={15} />
              </a>
            </div>
            <figure className={`window-preview window-preview-${host.id}`}>
              <div className="window-chrome">
                <span className="window-dots" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
                <span>
                  <host.Icon size={13} />
                  {host.chrome}
                </span>
                <span className="window-connected">
                  <i /> Connected
                </span>
              </div>
              <div className="window-session">
                <div className="window-chat">
                  <div className="window-chat-label">
                    <img src="/assets/logo.svg" alt="" width="21" height="21" />{' '}
                    DESKFISH <History size={14} />
                  </div>
                  <p className="window-user">
                    Compare the three hotels. Keep the ones with free
                    cancellation.
                  </p>
                  <p className="window-reply">
                    I checked the cancellation terms. Here’s the shortlist, with
                    the source links.
                  </p>
                  <div className="window-file">
                    <FileText size={18} />
                    <span>
                      hotel-shortlist.md<small>Ready to save</small>
                    </span>
                    <Check size={14} />
                  </div>
                  <span className="window-fact">
                    <Check size={12} /> Remembered your preference
                  </span>
                </div>
                <div className="window-desktop">
                  <div className="window-desktop-label">
                    <Monitor size={13} /> THE TANK
                  </div>
                  <div className="window-report">
                    <span>YOUR NEXT WEEKEND</span>
                    <h4>
                      A little room
                      <br />
                      to <em>get away.</em>
                    </h4>
                    {[1, 2, 3].map((n) => (
                      <div className="window-report-row" key={n}>
                        <span>0{n}</span>
                        <i />
                        <Check size={12} />
                      </div>
                    ))}
                    <p>Three options. Free cancellation.</p>
                  </div>
                </div>
              </div>
              <figcaption>
                <span className="status-dot" /> One shared conversation{' '}
                <span>Illustrated example</span>
              </figcaption>
            </figure>
          </TabsContent>
        ))}
        <div className="windows-home">
          <Server size={18} />
          <p>
            <strong>A home that stays on.</strong> Run Deskfish on your laptop,
            a small computer at home, or your own server. Its desktop and memory
            live there; your windows simply connect.
          </p>
          <a
            href="/docs/running-without-vscode/#where-she-should-live"
            aria-label="Choose where Deskfish runs"
          >
            <ArrowUpRight size={19} />
          </a>
        </div>
      </Tabs>
      <div className="agent-door" data-reveal>
        <span className="agent-door-icon">
          <Plug size={25} />
        </span>
        <div>
          <span className="micro-label">FOR YOUR OTHER AGENT, TOO</span>
          <h3>A pair of hands for your coding assistant.</h3>
          <p>
            Through MCP, a coding agent can hand Deskfish an errand, follow its
            progress, read the result, and give feedback in the chat. You can
            watch and stop the work from any window.
          </p>
        </div>
        <a
          className="text-link"
          href="/docs/advanced/#deskfish-as-an-mcp-server"
        >
          Connect over MCP <ArrowUpRight size={15} />
        </a>
      </div>
    </section>
  );
}
