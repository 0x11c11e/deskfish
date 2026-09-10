'use client';

import {
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Brain,
  CalendarClock,
  Check,
  Clock3,
  Feather,
  History,
  NotebookPen,
  Sprout,
} from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import './continuity.css';

const memories = [
  {
    id: 'self',
    label: 'Who it is',
    Icon: Feather,
    file: 'self.md',
    heading: 'In its own words.',
    description:
      'A small page about how it works, what it cares about, and the people it gets to know. Deskfish revises it during reflection; you can read it and talk about it together.',
    excerpt:
      'I do the job all the way through, and I say plainly what I did and what I did not.\n\nI check before I claim. A click that landed wrong is mine to notice and fix.',
    provenance: 'From the starting page that ships with every Deskfish.',
    detail: 'Versions are kept. Signatures make outside edits noticeable.',
    href: 'who-she-is',
  },
  {
    id: 'facts',
    label: 'Facts',
    Icon: Brain,
    file: 'memory.md',
    heading: 'The little things that matter.',
    description:
      'Your preferences, useful facts, and quirks of the sites it uses. Tell it what to remember or forget. Open the file to edit or clear it yourself.',
    excerpt:
      'Prefers hotels with free cancellation.\n\nInclude source links in research reports.\n\nSave finished reports in Downloads.',
    provenance: 'Illustrative notes. Your own fact file starts empty.',
    detail: 'Editable by you. Useful in the next conversation.',
    href: 'facts',
  },
  {
    id: 'journal',
    label: 'Journal',
    Icon: NotebookPen,
    file: 'journal.md',
    heading: 'A record of the work.',
    description:
      'Tasks leave a dated entry: what happened, the outcome, and a short summary. Deskfish can leave notes along the way and search the journal and past chats when the past matters.',
    excerpt:
      'Task · Compared three hotels with free cancellation. Saved a shortlist with links.\n\nNote · Check whether breakfast is included before comparing the total.',
    provenance: 'Illustrative journal entries, not a private chat transcript.',
    detail: 'Recent entries stay in mind. Older ones can be recalled.',
    href: 'the-journal',
  },
  {
    id: 'playbooks',
    label: 'Playbooks',
    Icon: BookOpen,
    file: 'playbook.md',
    heading: 'Something learned. Something kept.',
    description:
      'How-to notes it writes after learning a site or a task. Next time, it can read its own procedure instead of working it all out again. You can read and edit these too.',
    excerpt:
      'Wait for the numbers, not the frame: spinners and grey placeholders mean the figures are not there yet.\n\nSet the date range on purpose and confirm the page shows it; defaults differ between sites.',
    provenance: 'From the bundled starter playbook for dashboards and charts.',
    detail: 'Five starter playbooks. The next ones come from its work.',
    href: 'playbooks',
  },
];

export function ContinuitySection() {
  return (
    <section
      className="continuity-section section"
      id="memory"
      aria-labelledby="memory-title"
    >
      <div className="container">
        <div className="section-topline" data-reveal>
          <span className="eyebrow">
            <i /> 04 / A THREAD THAT CARRIES ON
          </span>
          <span className="side-note">
            The work ends. The story keeps going.
          </span>
        </div>
        <div className="continuity-heading" data-reveal>
          <h2 id="memory-title">
            A computer of its own.
            <br />A little <em>history, too.</em>
          </h2>
          <p>
            The useful facts. The lesson from a difficult task. A page about who
            it is, written in its own voice. Deskfish carries these between
            conversations, so your next hello has a little more behind it.
          </p>
        </div>
        <Tabs defaultValue="self" className="memory-notebook" data-reveal>
          <div className="notebook-top">
            <span>
              <Sprout size={16} /> ROOM TO GROW
            </span>
            <span>Kept on your machine</span>
          </div>
          <TabsList
            className="memory-tabs"
            aria-label="Explore the kinds of Deskfish memory"
          >
            {memories.map(({ id, label, Icon }) => (
              <TabsTrigger key={id} value={id}>
                <Icon size={16} />
                {label}
              </TabsTrigger>
            ))}
          </TabsList>
          {memories.map((memory) => (
            <TabsContent
              key={memory.id}
              value={memory.id}
              className="memory-panel"
            >
              <div className="memory-explanation">
                <span className="micro-label">{memory.file}</span>
                <h3>{memory.heading}</h3>
                <p>{memory.description}</p>
                <a className="text-link" href={`/docs/memory/#${memory.href}`}>
                  Read about {memory.label.toLowerCase()}{' '}
                  <ArrowUpRight size={14} />
                </a>
              </div>
              <figure className="memory-page">
                <div className="memory-page-label">
                  <memory.Icon size={15} />
                  <span>A LOOK INSIDE</span>
                </div>
                <blockquote>{memory.excerpt}</blockquote>
                <figcaption>{memory.provenance}</figcaption>
                <p className="memory-page-detail">
                  <Check size={14} />
                  {memory.detail}
                </p>
              </figure>
            </TabsContent>
          ))}
          <div className="reflection-note">
            <Feather size={19} />
            <div>
              <h3>A moment to reflect.</h3>
              <p>
                After a few tasks, Deskfish reviews its notes, saves what it
                learned, and may revise its page. A charter you can edit and a
                small library of readings give it something to think with.
                Changes stay folded in the chat, ready to open.
              </p>
            </div>
            <a
              href="/docs/memory/#reflection"
              aria-label="Read how reflection works"
            >
              <ArrowUpRight size={20} />
            </a>
          </div>
        </Tabs>
        <div className="continuity-footnotes" data-reveal>
          <a href="/docs/memory/#past-chats">
            <History size={18} />
            <span>
              <strong>Pick up an earlier conversation.</strong> Reopen saved
              text chats and continue with their transcript as context.
            </span>
            <ArrowUpRight size={15} />
          </a>
          <a href="/docs/memory/#backup-export-and-import">
            <Sprout size={18} />
            <span>
              <strong>Take the thread with you.</strong> Export its memory,
              history, playbooks, and chats to another installation.
            </span>
            <ArrowUpRight size={15} />
          </a>
        </div>
      </div>
    </section>
  );
}

export function RhythmSection() {
  return (
    <section
      className="rhythm-section section container"
      id="schedules"
      aria-labelledby="rhythm-title"
    >
      <div className="rhythm-copy" data-reveal>
        <span className="eyebrow">
          <i /> 05 / ON YOUR TIME
        </span>
        <h2 id="rhythm-title">
          Good work has
          <br />
          <em>a rhythm.</em>
        </h2>
        <p>
          A report on Monday. A check at the end of the day. Give a task a time,
          and Deskfish comes back to it. Once, daily, weekly, or every few
          minutes.
        </p>
        <p>
          Choose <strong>Schedule a Task…</strong> in Deskfish, set when, and
          describe the work. Results arrive in a new chat. If Deskfish is busy
          when a task is due, it waits for the current one to finish.
        </p>
        <a className="text-link" href="/docs/schedules/">
          Find your rhythm <ArrowUpRight size={15} />
        </a>
      </div>
      <div className="rhythm-agenda" data-reveal>
        <div className="agenda-top">
          <CalendarClock size={18} />
          <span>A LITTLE ROUTINE</span>
          <span>Examples</span>
        </div>
        <div className="agenda-entry">
          <div>
            <span>MON</span>
            <strong>09:00</strong>
          </div>
          <div>
            <h3>Start with the bigger picture.</h3>
            <p>
              Compare last week’s site traffic with the week before. Bring back
              the numbers and links.
            </p>
            <span>Every Monday</span>
          </div>
        </div>
        <div className="agenda-entry">
          <div>
            <span>DAILY</span>
            <strong>17:00</strong>
          </div>
          <div>
            <h3>Bring the report home.</h3>
            <p>
              Download today’s report from the dashboard and save it in
              Downloads.
            </p>
            <span>Every day</span>
          </div>
        </div>
        <div className="agenda-entry">
          <div>
            <span>EVERY</span>
            <strong>
              90<span>min</span>
            </strong>
          </div>
          <div>
            <h3>Check back when it’s time.</h3>
            <p>
              Visit the status page and tell me which services have an active
              incident.
            </p>
            <span>At a regular interval</span>
          </div>
        </div>
        <div className="agenda-limit">
          <Clock3 size={16} />
          <p>
            VS Code must be open, Deskfish loaded, and your machine awake.
            Missed times are skipped after a five-minute grace period by
            default.
          </p>
        </div>
      </div>
      <div className="standby-note" data-reveal>
        <span className="standby-mark">
          <Clock3 size={21} />
        </span>
        <div>
          <h3>And when the work needs a little waiting?</h3>
          <p>
            Standby watches for a screen change or waits out a timer locally. No
            repeated model calls while waiting. You see the reason and a
            countdown; Pause and Stop still work.
          </p>
        </div>
        <a href="/docs/how-the-bot-sees-and-acts/#standing-by">
          Meet standby <ArrowRight size={15} />
        </a>
      </div>
    </section>
  );
}
