'use client';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  Copy,
  Play,
  Monitor,
  MousePointer2,
  Hand,
  Globe2,
  Terminal,
  Paperclip,
  ScanSearch,
  BookOpen,
  ShieldCheck,
  Download,
  GitBranch,
  Code2,
  ChevronRight,
  Plane,
  Hotel,
  FileText,
  Search,
  Sparkles,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from '@/components/ui/accordion';
import { Brand } from './brand';

export function RevealObserver() {
  useEffect(() => {
    const nodes = document.querySelectorAll<HTMLElement>('[data-reveal]');
    if (
      window.matchMedia('(prefers-reduced-motion: reduce)').matches ||
      !('IntersectionObserver' in window)
    )
      return;
    const observer = new IntersectionObserver(
      (entries) =>
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-revealed');
            observer.unobserve(entry.target);
          }
        }),
      { threshold: 0.08 },
    );
    nodes.forEach((node) => {
      node.classList.add('will-reveal');
      observer.observe(node);
    });
    return () => {
      observer.disconnect();
      nodes.forEach((node) => node.classList.remove('will-reveal'));
    };
  }, []);
  return null;
}

export function CopyButton({
  text,
  label = 'Copy prompt',
  className = '',
}: {
  text: string;
  label?: string;
  className?: string;
}) {
  const [status, setStatus] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  async function copy() {
    try {
      if (!navigator.clipboard) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(text);
      setStatus('copied');
    } catch {
      setStatus('failed');
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setStatus('idle'), 3000);
  }
  return (
    <Button
      variant="ghost"
      className={`copy-button ${className}`}
      onClick={copy}
      aria-live="polite"
    >
      {status === 'copied' ? <Check /> : <Copy />}
      {status === 'copied'
        ? 'Copied!'
        : status === 'failed'
          ? 'Select text to copy'
          : label}
    </Button>
  );
}

export function ProductIntro() {
  return (
    <>
      <div className="foundation-strip container">
        <span>SMALL BY DESIGN. OPEN BY NATURE.</span>
        <div>
          <Monitor /> Your machine
        </div>
        <div>
          <Sparkles /> Your model
        </div>
        <div>
          <MousePointer2 /> Your call
        </div>
      </div>
      <section className="section container" id="how-it-works">
        <div className="section-topline" data-reveal>
          <span className="eyebrow">
            <i /> 01 / THE IDEA
          </span>
          <span className="side-note">
            A desktop agent with a little personality.
          </span>
        </div>
        <div className="intro-heading" data-reveal>
          <h2>
            A little less busywork.
            <br />A little more <em>possibility.</em>
          </h2>
          <p>
            Some tasks just need a patient pair of hands.
            <br />
            Deskfish opens the browser, follows the steps, and takes care of the
            clicking. All in a computer you can see.
          </p>
        </div>
        <div className="how-steps" data-reveal>
          {[
            {
              n: '01',
              icon: <ArrowUpRight />,
              title: 'Give it a task.',
              copy: 'Write like you would to a colleague. Tell it where to go, what matters, and what done looks like.',
              detail: 'YOUR WORDS → A PLAN',
            },
            {
              n: '02',
              icon: <Monitor />,
              title: 'Watch it get to work.',
              copy: 'It reads the page, looks at the screen, clicks, and types. A real browser and terminal, live in the app, your browser, or VS Code.',
              detail: 'LOOK → THINK → ACT → LOOK',
            },
            {
              n: '03',
              icon: <Hand />,
              title: 'Step in. Hand back.',
              copy: 'When it needs you, it knocks on the glass. Take the mouse, do your part, and let it carry on.',
              detail: 'A HUMAN, WHEN IT MATTERS',
            },
          ].map((item) => (
            <article className="how-step" key={item.n}>
              <div className="how-step-top">
                <span>{item.n}</span>
                {item.icon}
              </div>
              <h3>{item.title}</h3>
              <p>{item.copy}</p>
              <div className="micro-label">{item.detail}</div>
            </article>
          ))}
        </div>
      </section>
    </>
  );
}

const tasks = [
  {
    id: 'domain',
    icon: Globe2,
    title: 'Find a home on the web',
    label: 'Buy a domain',
    tag: 'A REAL DESKFISH FIRST',
    prompt:
      'Go to namecheap.com and buy deskfish.sh for yourself: one year, no add-ons. Stop before the final Pay button and knock.',
    steps: [
      'Find the domain and check availability',
      'Choose one year and skip the add-ons',
      'Get checkout ready and hand over at Pay',
    ],
    result: 'A little fish. Its very own domain.',
    file: 'deskfish.sh',
    fileLabel: 'The domain from our recorded demo',
    guide: 'knocking-on-the-glass',
  },
  {
    id: 'travel',
    icon: Plane,
    title: 'Make the weekend happen',
    label: 'Plan a trip',
    tag: 'LESS PLANNING, MORE GOING',
    prompt:
      'Find a round trip Madrid to Lisbon, leaving Friday after 17:00 and returning Sunday evening, under €150. Put the best option in the cart and knock when it is time to pay.',
    steps: [
      'Search the route and compare departure times',
      'Check total prices against the budget',
      'Prepare the best match for your review',
    ],
    result: 'Your next escape, with the legwork done.',
    file: 'Your flight shortlist',
    fileLabel: 'Times, prices, and booking links',
    guide: 'running-tasks',
  },
  {
    id: 'stays',
    icon: Hotel,
    title: 'Find somewhere you’ll love',
    label: 'Compare hotels',
    tag: 'MANY TABS. ONE GOOD ANSWER.',
    prompt:
      'Find the three best-rated hotels near Plaza Mayor in Madrid for my next weekend trip, with free cancellation. Ask me for the dates first, then give me names, prices and links.',
    steps: [
      'Get your dates and search the right area',
      'Compare reviews and cancellation policies',
      'Bring back three options with links',
    ],
    result: 'The details that make the decision easier.',
    file: 'Your hotel shortlist',
    fileLabel: 'Three options, clearly compared',
    guide: 'running-tasks',
  },
  {
    id: 'files',
    icon: FileText,
    title: 'Bring the paperwork home',
    label: 'Collect documents',
    tag: 'FROM THEIR DESKTOP TO YOURS',
    prompt:
      'Log into my electricity provider and download the last three invoices. Knock if you need me to sign in, and save the PDFs in your Downloads folder.',
    steps: [
      'Open the provider and ask for help if needed',
      'Find and download the last three invoices',
      'Offer each finished file in the chat',
    ],
    result: 'Your documents, one Save button away.',
    file: 'invoice.pdf',
    fileLabel: 'Ready to save to your computer',
    guide: 'files',
  },
  {
    id: 'research',
    icon: Search,
    title: 'Go down the rabbit holes',
    label: 'Research across sites',
    tag: 'THE WEB IS THE WORKSPACE',
    prompt:
      'Compare the pricing pages of Vercel, Netlify and Cloudflare Pages. Put the differences in a table, include the source links, and save the report in your Downloads folder.',
    steps: [
      'Visit each provider’s actual pricing page',
      'Gather the limits and costs that matter',
      'Create a comparison with source links',
    ],
    result: 'A useful answer from all those open tabs.',
    file: 'pricing-comparison.md',
    fileLabel: 'A report with the sources attached',
    guide: 'files',
  },
  {
    id: 'pdf',
    icon: FileText,
    title: 'Read beyond the download',
    label: 'Work with PDFs',
    tag: 'A DOCUMENT. A USEFUL ANSWER.',
    prompt:
      'Read the PDF I attached. Summarize the main findings, include page references, and save a Markdown report in Downloads. Tell me if any pages are unreadable.',
    steps: [
      'Open the attached PDF in the tank',
      'Read its text and inspect pages as needed',
      'Save a summary with page references',
    ],
    result: 'From a long document to the parts that matter.',
    file: 'document-summary.md',
    fileLabel: 'Attach a PDF with the paperclip first',
    guide: 'the-tank',
  },
  {
    id: 'terminal',
    icon: Terminal,
    title: 'Put the whole desktop to use',
    label: 'Use the terminal',
    tag: 'A BROWSER. AND EVERYTHING BESIDE IT.',
    prompt:
      'Use Python in your terminal to read the CSV I attached, remove exact duplicate rows, and save a cleaned copy in Downloads. Keep the original and tell me how many rows you removed.',
    steps: [
      'Open the terminal in the tank',
      'Read the attached CSV and remove duplicate rows',
      'Save a cleaned copy and report the changes',
    ],
    result: 'Real tools, on a real Linux desktop.',
    file: 'cleaned-data.csv',
    fileLabel: 'Attach a CSV with the paperclip first',
    guide: 'the-tank',
  },
];

export function TaskExplorer() {
  const [value, setValue] = useState('domain');
  return (
    <section className="possibilities section" id="possibilities">
      <div className="container">
        <div className="section-topline" data-reveal>
          <span className="eyebrow">
            <i /> 03 / A PAIR OF HANDS
          </span>
          <span className="side-note">
            For all the “open the browser and…” tasks.
          </span>
        </div>
        <div className="section-heading" data-reveal>
          <h2>
            Hand off the <em>little things.</em>
          </h2>
          <p>
            And some surprisingly big ones.
            <br />
            Pick an errand. Imagine what you could do with the time.
          </p>
        </div>
        <Tabs
          value={value}
          onValueChange={(v) => setValue(String(v))}
          orientation="vertical"
          className="task-explorer"
          data-reveal
        >
          <TabsList
            aria-label="Explore Deskfish task examples"
            className="task-list"
          >
            {tasks.map((task) => (
              <TabsTrigger
                className="task-trigger"
                value={task.id}
                key={task.id}
              >
                <task.icon />
                <span>{task.label}</span>
                <ChevronRight />
              </TabsTrigger>
            ))}
          </TabsList>
          <div className="task-panel-wrap">
            {tasks.map((task) => (
              <TabsContent value={task.id} key={task.id} className="task-panel">
                <div className="task-panel-top">
                  <span className="micro-label">{task.tag}</span>
                  <span className="task-example-label">EXAMPLE PROMPT</span>
                </div>
                <h3>{task.title}</h3>
                <blockquote>{task.prompt}</blockquote>
                <div className="task-actions">
                  <CopyButton text={task.prompt} />
                  <a href={`/docs/${task.guide}/`}>
                    How it works <ArrowUpRight size={13} />
                  </a>
                </div>
                <div className="task-journey">
                  {task.steps.map((step, i) => (
                    <div key={step}>
                      <span>0{i + 1}</span>
                      {step}
                    </div>
                  ))}
                </div>
                <div className="task-outcome">
                  <div className="outcome-icon">
                    {task.id === 'domain' ? <Globe2 /> : <FileText />}
                  </div>
                  <div>
                    <strong>{task.file}</strong>
                    <span>{task.fileLabel}</span>
                  </div>
                  <CircleCheckIcon />
                </div>
                <p className="task-result">{task.result}</p>
              </TabsContent>
            ))}
          </div>
        </Tabs>
        <p className="example-note">
          Illustrative workflows. What an agent can complete depends on your
          model and the sites it visits.
        </p>
      </div>
    </section>
  );
}
function CircleCheckIcon() {
  return (
    <span className="circle-check">
      <Check size={11} />
    </span>
  );
}

export function HandoffSection() {
  const [taken, setTaken] = useState(false);
  return (
    <section className="section container tank-section" id="the-tank">
      <div className="tank-story" data-reveal>
        <span className="eyebrow">
          <i /> 04 / MEET THE TANK
        </span>
        <h2>
          Its own little world.
          <br />A <em>clear boundary.</em>
        </h2>
        <p>
          The tank is a sandboxed Linux desktop on the machine you choose. Its
          own browser, its own files, its own space to get things done.
        </p>
        <div className="boundary-points">
          <div>
            <Monitor />
            <div>
              <h3>The computer is theirs.</h3>
              <p>
                Firefox, a terminal, and a home folder that keeps logins and
                files between restarts.
              </p>
            </div>
          </div>
          <div>
            <ShieldCheck />
            <div>
              <h3>Your files stay yours.</h3>
              <p>
                No host folder is mounted. You choose what crosses the glass
                with Attach and Save.
              </p>
            </div>
          </div>
          <div>
            <Hand />
            <div>
              <h3>The mouse is always within reach.</h3>
              <p>
                Watch every step. Take over at any time. Hand back when you’re
                ready.
              </p>
            </div>
          </div>
        </div>
        <a className="text-link" href="/docs/security-and-privacy/">
          Get to know the boundary <ArrowUpRight size={15} />
        </a>
      </div>
      <div className={`tank-visual ${taken ? 'is-taken' : ''}`} data-reveal>
        <div className="tank-visual-top">
          <span>
            <span className="status-dot" /> THE TANK
          </span>
          <span>YOURS TO WATCH</span>
        </div>
        <img
          src="/assets/tank.png"
          alt="The actual Deskfish Linux desktop, with the fish-in-a-monitor wallpaper and Firefox and Terminal in the dock"
          width="1280"
          height="800"
          loading="lazy"
        />
        <div className="handoff-preview">
          <div className="handoff-icon">
            {taken ? <MousePointer2 /> : <Hand />}
          </div>
          <div className="handoff-preview-content" aria-live="polite">
            <span className="micro-label">A LITTLE KNOCK ON THE GLASS</span>
            <h3>{taken ? 'The desktop is yours.' : 'Deskfish needs you.'}</h3>
            <p>
              {taken
                ? 'The agent waits. Hand back when you’re ready to continue.'
                : 'Something needs a human touch. Step in, then let it carry on.'}
            </p>
          </div>
          <Button className="handoff-button" onClick={() => setTaken(!taken)}>
            {taken ? 'Hand back' : 'Try taking over'} <ArrowRight size={14} />
          </Button>
          <span className="handoff-demo-label">
            Interactive handoff illustration
          </span>
        </div>
        <div className="tank-spec">
          <span>DEBIAN + OPENBOX</span>
          <span>POWERED BY PODMAN OR DOCKER</span>
        </div>
      </div>
    </section>
  );
}

export function DetailsSection() {
  return (
    <section
      className="details-section container"
      aria-label="The thoughtful little details"
    >
      <div className="details-heading" data-reveal>
        <span className="eyebrow">
          <i /> THE THOUGHTFUL LITTLE DETAILS
        </span>
        <h2>More than a fresh pair of fins.</h2>
      </div>
      <div className="details-grid" data-reveal>
        {[
          {
            icon: ScanSearch,
            title: 'It can read the page.',
            copy: 'Read page text directly and click a visible control by name in one step. Screenshots and zoom cover the rest.',
            href: 'how-the-bot-sees-and-acts#reading-the-page-instead-of-the-picture',
          },
          {
            icon: Paperclip,
            title: 'Files go both ways.',
            copy: 'Attach what it needs. Save what it makes. No shared folder required.',
            href: 'files',
          },
          {
            icon: BookOpen,
            title: 'It reads its own manual.',
            copy: 'Ask about Deskfish. It looks up the same documentation you use before answering.',
            href: 'introduction',
          },
          {
            icon: GitBranch,
            title: 'Long jobs keep a ledger.',
            copy: 'It keeps a summary as the conversation grows. After an interruption, the next task gets a note of where things stopped.',
            href: 'how-the-bot-sees-and-acts#long-tasks-the-ledger',
          },
        ].map((item) => (
          <a
            className="detail-item"
            href={`/docs/${item.href.split('#')[0]}/${item.href.includes('#') ? `#${item.href.split('#')[1]}` : ''}`}
            key={item.title}
          >
            <item.icon className="detail-icon" />
            <h3>
              {item.title}
              <ArrowUpRight size={13} />
            </h3>
            <p>{item.copy}</p>
          </a>
        ))}
      </div>
    </section>
  );
}

const models = [
  {
    id: 'claude',
    name: 'Claude',
    label: 'NATIVE COMPUTER USE',
    title: 'A familiar mind. A new pair of hands.',
    copy: 'Connect directly to Anthropic’s computer-use API. Deskfish handles screenshots, actions, prompt caching, and conversation compaction.',
    code: '{\n  "deskfish.provider": "anthropic",\n  "deskfish.model": "<your-computer-use-model>",\n  "deskfish.baseUrl": ""\n}',
    note: 'Choose a Claude model that supports computer use.',
  },
  {
    id: 'compatible',
    name: 'OpenAI-compatible',
    label: 'ONE ADAPTER. MANY POSSIBILITIES.',
    title: 'Your favorite endpoint is welcome.',
    copy: 'Connect OpenRouter, xAI, Moonshot AI (Kimi), LiteLLM, or another OpenAI-compatible API. The same desktop and tools, with prompt caching available through OpenRouter and compatible gateways.',
    code: '{\n  "deskfish.provider": "openai-compatible",\n  "deskfish.model": "<your-vision-and-tools-model>",\n  "deskfish.baseUrl": "https://openrouter.ai/api/v1"\n}',
    note: 'The model needs both vision and tool calling.',
  },
  {
    id: 'grok',
    name: 'Grok sign-in',
    label: 'A PLAN YOU ALREADY HAVE.',
    title: 'Let your SuperGrok go to work.',
    copy: 'Deskfish can draw from your SuperGrok subscription through Sign in with Grok. Choose the sign-in preset, approve the code on xAI’s page, and return to your task.',
    code: '',
    note: 'xAI controls account eligibility. If the pool runs out, Deskfish pauses; it never silently switches to a billed API key.',
  },
  {
    id: 'local',
    name: 'Local models',
    label: 'KEEP THE MODEL CLOSE, TOO.',
    title: 'A little world, a little more local.',
    copy: 'Point Deskfish at your own Ollama or vLLM endpoint. Choose a model with vision and tool calling, and keep inference on your machine.',
    code: '{\n  "deskfish.provider": "openai-compatible",\n  "deskfish.model": "<your-local-model>",\n  "deskfish.baseUrl": "http://localhost:11434/v1"\n}',
    note: 'Capability and click accuracy depend on the model.',
  },
];
export function ModelSection() {
  return (
    <section className="models-section section" id="models">
      <div className="container">
        <div className="section-topline" data-reveal>
          <span className="eyebrow">
            <i /> 07 / YOUR CHOICE, ALWAYS
          </span>
          <span className="side-note">
            The desktop stays. The mind is up to you.
          </span>
        </div>
        <h2 data-reveal>
          One tank.
          <br />
          <em>Many kinds of smart.</em>
        </h2>
        <p className="model-picker-intro" data-reveal>
          Click <strong>Change</strong> next to Model. Choose a provider and a
          model, then add its key or sign in where supported. Your memory and
          playbooks stay with Deskfish when you change the model.
        </p>
        <Tabs defaultValue="claude" className="model-tabs" data-reveal>
          <TabsList
            className="model-tab-list"
            aria-label="Choose a model connection"
          >
            {models.map((model) => (
              <TabsTrigger key={model.id} value={model.id}>
                {model.name}
              </TabsTrigger>
            ))}
          </TabsList>
          {models.map((model) => (
            <TabsContent
              className="model-panel"
              value={model.id}
              key={model.id}
            >
              <div>
                <span className="micro-label">{model.label}</span>
                <h3>{model.title}</h3>
                <p>{model.copy}</p>
                <a className="text-link" href="/docs/models-and-providers/">
                  Explore models and providers <ArrowUpRight size={15} />
                </a>
              </div>
              <div className="model-setup">
                <span className="micro-label">IN ANY DESKFISH WINDOW</span>
                <ol>
                  <li>
                    Open <strong>Change</strong> next to Model.
                  </li>
                  <li>
                    {model.id === 'claude'
                      ? 'Choose Anthropic (direct), then a computer-use model.'
                      : model.id === 'grok'
                        ? 'Choose xAI (Grok) — sign in with your SuperGrok.'
                        : model.id === 'local'
                          ? 'Choose Ollama, or enter your own local endpoint.'
                          : 'Choose your provider, then a model with vision and tools.'}
                  </li>
                  <li>
                    {model.id === 'grok'
                      ? 'Press Sign in with Grok and approve the code on xAI’s page.'
                      : model.id === 'local'
                        ? 'Keep your local model server running and send a task.'
                        : 'Enter that provider’s API key when prompted.'}
                  </li>
                </ol>
                <p>
                  {model.id === 'compatible'
                    ? 'Direct Kimi is provided by Moonshot AI in Beijing. The chosen endpoint receives your key and task content; OpenRouter routes content to its serving provider.'
                    : model.note}
                </p>
                {model.code && (
                  <details className="model-settings">
                    <summary>Prefer settings JSON?</summary>
                    <div className="model-code">
                      <div className="code-title">
                        <span>
                          <Code2 size={13} /> VS CODE · USER SETTINGS
                        </span>
                        <CopyButton label="Copy" text={model.code} />
                      </div>
                      <pre>
                        <code>{model.code}</code>
                      </pre>
                      <div className="code-note">
                        <span className="status-dot" />
                        {model.note}
                      </div>
                    </div>
                  </details>
                )}
              </div>
            </TabsContent>
          ))}
        </Tabs>
        <div className="model-footer">
          <span>
            No Deskfish subscription. API key, Grok sign-in, or a local model.
          </span>
          <span>
            Credentials stay with your Deskfish. Hosted inference goes to your
            chosen provider.
          </span>
        </div>
      </div>
    </section>
  );
}

type Film = {
  id: string;
  title: string;
  when: string;
  duration: string;
  blurb: string;
  poster: string;
  src: string;
  captions: string;
  alt: string;
};

const films: Film[] = [
  {
    id: 'post',
    title: 'Deskfish writes a post.',
    when: '10 September 2026',
    duration: '02:13',
    blurb:
      'Told to read what people on X are saying this week about agents that use a computer, then draft a post from its own account and leave it unsent. It reads, it writes, and it stops at the Post button.',
    poster: '/assets/films/post.jpg',
    src: '/assets/films/post.mp4',
    captions: '/assets/films/post.vtt',
    alt: 'Deskfish in VS Code: the chat on the left, and in its own desktop Firefox is open on an X search for computer-use agents',
  },
  {
    id: 'trip',
    title: 'Deskfish prices a trip.',
    when: '10 September 2026',
    duration: '02:03',
    blurb:
      'The cheapest LAX to Hawaii fare for fixed dates. It uses the Explore view on Google Flights to compare every island at once, opens the winner, checks the return leg, and reports the catch: the red-eye lands a day later than “a week”.',
    poster: '/assets/films/trip.jpg',
    src: '/assets/films/trip.mp4',
    captions: '/assets/films/trip.vtt',
    alt: 'Deskfish in VS Code: Google Flights in its own desktop with prices for every Hawaiian island on a map',
  },
  {
    id: 'domain',
    title: 'Deskfish buys its own domain.',
    when: '2 September 2026',
    duration: '04:09',
    blurb:
      'Its first task. It finds deskfish.sh on Namecheap, signs in, prepares the purchase and knocks on the glass; its human presses Pay. Account and card details are blacked out.',
    poster: '/assets/films/domain.jpg',
    src: '/assets/films/domain.mp4',
    captions: '/assets/demo-captions.vtt',
    alt: 'Deskfish in VS Code: Namecheap in its own desktop, showing deskfish.sh available at $34.98 a year',
  },
];

export function FilmSection() {
  const [active, setActive] = useState<Film | null>(null);
  const [mediaError, setMediaError] = useState(false);
  return (
    <section className="section container film-section" id="demo">
      <div className="film-copy" data-reveal>
        <span className="eyebrow">
          <i /> 08 / THREE REAL RECORDINGS
        </span>
        <h2>
          Watch it work.
          <br />
          <em>Through the glass.</em>
        </h2>
        <p>
          Three unedited sessions, recorded in VS Code: the chat on the left,
          its own desktop on the right. It reads a timeline and drafts a post.
          It prices a trip. And on its first day, it bought this website’s
          address.
        </p>
        <p className="film-punchline">
          This website’s address was its first errand.
        </p>
        <figure className="fish-quote">
          <blockquote>
            “‘AI’ is a category label; ‘.sh’ is a job description.”
          </blockquote>
          <figcaption>— Deskfish, on keeping deskfish.sh.</figcaption>
        </figure>
        <div className="film-meta">
          <span>REAL TIME</span>
          <i />
          <span>NO AUDIO</span>
          <i />
          <span>NOTHING STAGED</span>
        </div>
      </div>
      <div className="film-preview" data-reveal>
        <div className="film-grid">
          {films.map((film, i) => (
            <Button
              key={film.id}
              variant="ghost"
              className={i === 0 ? 'film-open film-open-lead' : 'film-open'}
              aria-label={`Play the recording: ${film.title}`}
              onClick={() => {
                setMediaError(false);
                setActive(film);
              }}
            >
              <img
                src={film.poster}
                width="1600"
                height="862"
                alt={film.alt}
                loading="lazy"
              />
              <span className="film-shade" />
              <span className="film-play">
                <Play fill="currentColor" size={i === 0 ? 24 : 18} />
              </span>
              <span className="film-caption">
                <span>{film.title}</span>
                <span>
                  {film.duration} <ArrowUpRight size={15} />
                </span>
              </span>
            </Button>
          ))}
        </div>
        <p>Three real recordings · Real time · No audio</p>
      </div>
      <Dialog
        open={!!active}
        onOpenChange={(open) => {
          if (!open) setActive(null);
        }}
      >
        <DialogContent className="film-dialog">
          <DialogTitle>{active?.title}</DialogTitle>
          <DialogDescription>
            {active
              ? `${active.when} · ${active.duration} · silent. ${active.blurb}`
              : ''}
          </DialogDescription>
          {active &&
            (mediaError ? (
              <div className="video-error">
                <p>The video couldn’t play in this browser.</p>
                <a href={active.src} download className="text-link">
                  Download the recording <Download size={15} />
                </a>
              </div>
            ) : (
              <video
                key={active.id}
                controls
                autoPlay
                playsInline
                preload="none"
                poster={active.poster}
                onError={() => setMediaError(true)}
              >
                <source src={active.src} type="video/mp4" />
                <track
                  kind="captions"
                  src={active.captions}
                  srcLang="en"
                  label="English (silent recording)"
                />
                Your browser does not support video playback.
              </video>
            ))}
        </DialogContent>
      </Dialog>
    </section>
  );
}

/**
 * Every release carries the same six files under the same names, so /downloads/<name> can be a
 * fixed redirect to releases/latest/download/<name> (see vercel.json).
 */
const DOWNLOADS = {
  linux: { file: 'Deskfish-linux-x86_64.AppImage', system: 'Linux' },
  mac: { file: 'Deskfish-mac-universal.dmg', system: 'macOS' },
  windows: { file: 'Deskfish-windows-x64-setup.exe', system: 'Windows' },
} as const;

const OTHER_DOWNLOADS = [
  { label: 'AppImage', file: 'Deskfish-linux-x86_64.AppImage' },
  { label: 'deb', file: 'Deskfish-linux-amd64.deb' },
  { label: 'dmg', file: 'Deskfish-mac-universal.dmg' },
  { label: 'exe', file: 'Deskfish-windows-x64-setup.exe' },
  { label: 'VS Code extension', file: 'deskfish.vsix' },
  { label: 'npm tarball', file: 'deskfish.tgz' },
];

const RELEASE_URL = 'https://github.com/0x11c11e/deskfish/releases/latest';
const releaseFile = (file: string) => `${RELEASE_URL}/download/${file}`;

/** Offer a desktop download only when the browser identifies a desktop system. */
function guessSystem(): keyof typeof DOWNLOADS | null {
  if (typeof navigator === 'undefined') return null;
  const nav = navigator as Navigator & {
    userAgentData?: { platform?: string };
  };
  const p = (nav.userAgentData?.platform || nav.platform || '').toLowerCase();
  if (
    /android|iphone|ipad|ipod/i.test(nav.userAgent) ||
    (p.includes('mac') && nav.maxTouchPoints > 1)
  )
    return null;
  if (p.includes('mac')) return 'mac';
  if (p.includes('win')) return 'windows';
  if (p.includes('linux') && !/arm|aarch/i.test(p)) return 'linux';
  return null;
}

const subscribeToSystem = () => () => {};
const unknownSystem = () => null;

/** The app for the visitor's system, with every other file one quiet line below. */
function DownloadApp() {
  const target = useSyncExternalStore(
    subscribeToSystem,
    guessSystem,
    unknownSystem,
  );
  const download = target ? DOWNLOADS[target] : null;
  return (
    <>
      <a
        className="button button-mint"
        href={download ? releaseFile(download.file) : RELEASE_URL}
      >
        <Download size={17} />{' '}
        {download
          ? `Download for ${download.system}`
          : 'Choose your desktop app'}{' '}
        <ArrowUpRight size={18} />
      </a>
      <a className="release-link" href={RELEASE_URL}>
        Latest release · app, extension, or server <ArrowUpRight size={12} />
      </a>
      <div className="other-downloads">
        {OTHER_DOWNLOADS.map((d, i) => (
          <span key={d.file}>
            {i > 0 && <i aria-hidden="true"> · </i>}
            <a href={releaseFile(d.file)}>{d.label}</a>
          </span>
        ))}
      </div>
    </>
  );
}

const faq = [
  {
    q: 'Do I need VS Code?',
    a: 'No. Download the desktop app, or open the page served by a running Deskfish in your browser. VS Code is another window onto the same agent. On one machine, the app and extension share its desktop, memory, chats, settings, and schedules.',
    href: 'running-without-vscode',
  },
  {
    q: 'Is this an AI coding assistant?',
    a: 'Deskfish is for the work that needs a browser, a mouse, and a little patience: finding a hotel, collecting receipts, filling forms, researching across sites. Use the app, a browser, or VS Code to keep an eye on it alongside your work. Coding agents can also delegate errands to it over MCP.',
  },
  {
    q: 'Does it control my actual computer?',
    a: 'The agent operates its own Linux desktop in a container. Your host folders are not mounted. Files cross when you attach or save them; the Desktop tab also shares the clipboard. The tank has outbound network access, including reachable LAN services. Deskfish warns if it falls back to sharing the host’s network. The security guide explains the boundary.',
    href: 'security-and-privacy',
  },
  {
    q: 'What stays local, and what goes to the model?',
    a: 'The tank, memory, and saved chats live on the machine running Deskfish: your computer, a box at home, or a server you choose. Task text, tank screenshots, page text or controls requested by the agent, action results, and relevant notes go to your chosen model endpoint. Your own screen is not captured. A compatible local endpoint can keep inference on your machine too.',
    href: 'security-and-privacy',
  },
  {
    q: 'Can I choose how independently it works?',
    a: 'Yes. Free mode is the default: the tank, its accounts, and its files are the agent’s to use. Guided mode adds instructions to ask before consequential steps. You can take over or stop a task at any time. The model you choose may also have limits of its own.',
    href: 'knocking-on-the-glass',
  },
  {
    q: 'What do I need to run it?',
    a: 'The app or VS Code extension, Podman or Docker for the tank, and a model with vision and tool calling. Deskfish offers to help install Podman. Linux is the main development platform; macOS and Windows installers are built but have not yet been tested end to end on those systems. The first tank build takes a few minutes.',
    href: 'getting-started',
  },
  {
    q: 'Is it free? Can I try it without an API key?',
    a: 'Deskfish is free software under the Apache 2.0 license. Hosted model providers charge for usage, or eligible Grok accounts can draw from their existing SuperGrok plan. A scripted mock provider lets you try the desktop and handoff flow with no API key. Local inference is also an option with a compatible model.',
    href: 'models-and-providers',
  },
  {
    q: 'What does it remember?',
    a: 'Facts, a task journal, reusable playbooks, a self-description, and text transcripts of past chats. Reopen a past chat to continue with its transcript as context; the live model conversation is not restored exactly. You can edit facts and playbooks, read its self-description, and export the memory and chat history. Browser logins and files persist separately in the tank.',
    href: 'memory',
  },
  {
    q: 'Can it come back to a task on a schedule?',
    a: 'Yes: once, daily, weekly, or at an interval of at least five minutes. Create it in Scheduled tasks. Deskfish must be running and its machine awake; VS Code can be closed. Automatic runs default to guided mode and a $2 model budget where costs are known, with per-schedule overrides. Busy tasks queue; missed times are skipped after the grace period, five minutes by default.',
    href: 'schedules',
  },
  {
    q: 'How does it keep long tasks manageable?',
    a: 'A ledger periodically replaces the growing conversation with a summary of the goal, progress, remaining work, and current state. Prompt caching reduces repeated input costs where supported, and standby polls locally without repeated model calls. There is no step cap by default. Optional cost budgets work with known direct Claude, Kimi, or Grok prices, or charges reported by the endpoint; final requests can take a run over the budget.',
    href: 'running-tasks',
  },
];
export function FaqSection() {
  return (
    <section className="section container faq-section" id="questions">
      <div className="faq-heading" data-reveal>
        <span className="eyebrow">
          <i /> A FEW GOOD QUESTIONS
        </span>
        <h2>
          Curious?
          <br />
          <em>Come closer.</em>
        </h2>
        <a className="text-link" href="/docs/">
          There’s a whole manual <ArrowUpRight size={15} />
        </a>
      </div>
      <Accordion className="faq-list" data-reveal>
        {faq.map((item, i) => (
          <AccordionItem key={item.q} value={String(i)}>
            <AccordionTrigger>{item.q}</AccordionTrigger>
            <AccordionContent>
              <p>{item.a}</p>
              {item.href && (
                <a className="faq-guide" href={`/docs/${item.href}/`}>
                  Read the guide <ArrowUpRight size={13} />
                </a>
              )}
            </AccordionContent>
          </AccordionItem>
        ))}
      </Accordion>
    </section>
  );
}

export function GetStarted() {
  return (
    <section className="get-started" id="get-started">
      <div className="container">
        <div className="get-started-top" data-reveal>
          <div>
            <span className="eyebrow">
              <i /> MAKE A LITTLE ROOM
            </span>
            <h2>
              Your AI’s next chapter
              <br />
              starts with <em>a desk.</em>
            </h2>
          </div>
          <div className="get-started-action">
            <DownloadApp />
            <a href="/docs/the-app/" className="setup-guide">
              App installation guide <ArrowUpRight size={13} />
            </a>
          </div>
        </div>
        <div className="install-steps" data-reveal>
          <div>
            <span>01</span>
            <h3>Give it a home.</h3>
            <p>
              Download and open the app. Prefer your editor? Install the
              extension with <strong>Install from VSIX…</strong> in VS Code.
            </p>
          </div>
          <div>
            <span>02</span>
            <h3>Bring a mind.</h3>
            <p>
              Click <strong>Change</strong> next to Model. Choose a provider and
              model, then enter its key or use Grok sign-in.
            </p>
          </div>
          <div>
            <span>03</span>
            <h3>Let it swim.</h3>
            <p>
              Turn on the tank. If you need Podman, Deskfish walks you through
              installation. Give your fish its first task.
            </p>
          </div>
        </div>
        <div className="install-routes" data-reveal>
          <a href="/docs/getting-started/#2-install-the-extension">
            <Code2 size={17} />
            <span>
              In VS Code<small>Install the extension</small>
            </span>
            <ArrowUpRight size={15} />
          </a>
          <a href="/docs/advanced/#a-gateway-on-another-machine">
            <Terminal size={17} />
            <span>
              On your own server
              <small>Install the command, open the web page</small>
            </span>
            <ArrowUpRight size={15} />
          </a>
          <a href="/docs/running-without-vscode/#signing-in-once">
            <Globe2 size={17} />
            <span>
              Already running?<small>Connect from your browser</small>
            </span>
            <ArrowUpRight size={15} />
          </a>
        </div>
        <p className="install-caveat">
          The app is unsigned. macOS and Windows builds still need testing on
          those systems.{' '}
          <a href="/docs/the-app/#honest-limits">
            Read the installation notes <ArrowUpRight size={12} />
          </a>
        </p>
        <div className="install-footnote">
          <span>
            Early release. Built in the open, with plenty of room to grow.
          </span>
          <a href="/docs/getting-started/#2-install-the-extension">
            Prefer to build from source? <ArrowUpRight size={13} />
          </a>
        </div>
      </div>
    </section>
  );
}

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="container footer-top">
        <div>
          <Brand />
          <p>
            Give your AI its own computer.
            <br />
            Watch it work through the glass.
          </p>
        </div>
        <div className="footer-links">
          <div>
            <span>EXPLORE</span>
            <a href="/#ways-in">App, browser & VS Code</a>
            <a href="/#the-tank">The tank</a>
            <a href="/#memory">Memory & reflection</a>
            <a href="/#schedules">Schedules</a>
            <a href="/#models">The models</a>
            <a href="/#demo">Watch the recordings</a>
          </div>
          <div>
            <span>MAKE IT YOURS</span>
            <a
              href="https://github.com/0x11c11e/deskfish"
              target="_blank"
              rel="noopener"
            >
              Source code on GitHub <ArrowUpRight size={12} />
            </a>
            <a href="/docs/">Documentation</a>
            <a href="/docs/security-and-privacy/">Security & privacy</a>
            <a href="/LICENSE.txt">Apache 2.0 license</a>
            <a href="/NOTICE.txt">Attributions</a>
          </div>
          <div>
            <span>LOOK CLOSER</span>
            <a href="/docs/how-the-bot-sees-and-acts/">
              Under the hood <ArrowUpRight size={12} />
            </a>
            <a href="/docs/advanced/#deskfish-as-an-mcp-server">
              Connect over MCP <ArrowUpRight size={12} />
            </a>
            <a href="/#get-started">Get Deskfish</a>
          </div>
          <div>
            <span>SAY HELLO</span>
            <a href="mailto:hello@deskfish.sh">hello@deskfish.sh</a>
            <a
              href="https://github.com/0x11c11e/deskfish/issues"
              target="_blank"
              rel="noopener"
            >
              Open an issue <ArrowUpRight size={12} />
            </a>
            <a
              href="https://github.com/0x11c11e/deskfish/blob/main/CONTRIBUTING.md"
              target="_blank"
              rel="noopener"
            >
              Contribute <ArrowUpRight size={12} />
            </a>
            <a href="mailto:security@deskfish.sh">Report a vulnerability</a>
          </div>
        </div>
      </div>
      <div className="container footer-bottom">
        <span>© 2026 Iman Reihanian · Creator of Deskfish.</span>
        <span>
          <span className="status-dot" /> A small beginning. An open future.
        </span>
        <a href="#main" aria-label="Back to top">
          Back to the surface ↑
        </a>
      </div>
      <div className="footer-wordmark" aria-hidden="true">
        deskfish<span>.</span>
      </div>
    </footer>
  );
}
