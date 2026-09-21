import type { ReplayItem } from '../agent/chats';
import { WEEKDAYS, inAnHour, parseBudget, whenFromFields } from '../agent/scheduleForm';
import type { DeskfishConfig } from '../gateway/config';
import { patchBetween } from '../gateway/configSync';
import type { ChatInfo, CommandArgs, CommandResult } from '../gateway/protocol';
import { GROUP_TITLES, settingLabel, type SettingsEntry, type SettingsSchema } from '../gateway/settingsSchema';
import type { ViewCommand } from './bridge';
import { AUTONOMY_DETAILS, SECRET_SETTINGS, budgetHint, chatTitle, fieldInput, filterChats, groupChats, outcomeLabel, readField, refusalOf, type FieldInput, type ScheduleForm, type SettingsRefusal } from './forms';
import { mdLite } from './markdown';
import type { FromChat, PanelName } from './protocol';

/**
 * The chat view's panels (gateway plan step 6B): Past chats, Settings, Scheduled tasks and Her files,
 * each over the log and the composer, in both hosts. Host chrome only opens them (`open`); their data
 * comes from the gateway through the view's bridge (`ask`). Every string from the gateway is set with
 * `textContent`, or through `mdLite` (which escapes first) for her files.
 */

export interface PanelDeps {
  host: 'vscode' | 'web';
  ask<K extends ViewCommand>(cmd: K, args?: CommandArgs<K>): Promise<CommandResult<K>>;
  post(m: FromChat): void;
  /** Show a past chat in place of the live one. */
  showPast(info: ChatInfo, items: ReplayItem[]): void;
  /** A panel opened (true) or the last one closed (false): the view hides or shows the log and the composer. */
  toggled(open: boolean): void;
}

export interface Panels {
  open(panel: PanelName): void;
  close(): void;
  readonly current: PanelName | undefined;
  /** Something that can change the schedules' lines happened (a schedule fired, a run ended). */
  schedulesMayHaveChanged(): void;
}

const msg = (err: unknown) => (err instanceof Error ? err.message : String(err));
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function setNote(note: HTMLElement, text: string, tone?: 'error' | 'ok'): void {
  note.textContent = text;
  note.className = `note${tone ? ` ${tone}` : ''}`;
}

const TRASH =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>';

/**
 * A button that asks once on itself: the first click shows `question`, the second runs `action`; it
 * resets after a few seconds. `after` runs once the action is over (to set the button's own state again).
 */
function confirmOnce(button: HTMLButtonElement, question: () => string, action: () => Promise<void>, after?: () => void): void {
  let armed: { html: string; asked: string; timer: ReturnType<typeof setTimeout> } | undefined;
  const disarm = () => {
    if (!armed) return;
    clearTimeout(armed.timer);
    if (button.textContent === armed.asked) button.innerHTML = armed.html;
    button.classList.remove('confirm');
    armed = undefined;
  };
  button.addEventListener('click', async (ev) => {
    ev.stopPropagation();
    if (!armed) {
      const asked = question();
      armed = { html: button.innerHTML, asked, timer: setTimeout(disarm, 5000) };
      button.textContent = asked;
      button.classList.add('confirm');
      return;
    }
    clearTimeout(armed.timer);
    button.disabled = true;
    try {
      await action();
    } finally {
      button.disabled = false;
      disarm();
      after?.();
    }
  });
}

export function createPanels(deps: PanelDeps): Panels {
  const sections: Record<PanelName, HTMLElement> = {
    history: $('panel-history'),
    settings: $('panel-settings'),
    schedules: $('panel-schedules'),
    files: $('panel-files'),
  };
  let current: PanelName | undefined;
  /** Bumped on every open, so a slow answer for a panel that was closed or reopened meanwhile is dropped. */
  let generation = 0;

  const close = () => {
    if (!current) return;
    sections[current].hidden = true;
    current = undefined;
    generation++;
    deps.toggled(false);
  };

  for (const section of Object.values(sections)) section.querySelector('.panel-close')?.addEventListener('click', close);
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && current && !ev.defaultPrevented) close();
  });

  /* ---------- Past chats ---------- */

  const historyList = $<HTMLDivElement>('historyList');
  const historyFilter = $<HTMLInputElement>('historyFilter');
  const historyNote = $<HTMLParagraphElement>('historyNote');
  const deleteAll = $<HTMLButtonElement>('historyDeleteAll');
  let chats: ChatInfo[] = [];

  const renderHistory = () => {
    const shown = filterChats(chats, historyFilter.value);
    deleteAll.hidden = chats.length === 0;
    historyFilter.hidden = chats.length === 0;
    if (!chats.length) {
      historyList.replaceChildren(el('p', 'empty-line', 'No past chats yet. A chat is kept here when you start a new one.'));
      return;
    }
    if (!shown.length) {
      historyList.replaceChildren(el('p', 'empty-line', `No past chat has “${historyFilter.value.trim()}” in its title.`));
      return;
    }
    const out: HTMLElement[] = [];
    for (const group of groupChats(shown, new Date())) {
      out.push(el('h3', 'day', group.label));
      for (const c of group.chats) out.push(chatRow(c));
    }
    historyList.replaceChildren(...out);
  };

  const chatRow = (c: ChatInfo): HTMLElement => {
    const row = el('div', 'chat-row');
    const open = el('button', 'chat-open');
    open.type = 'button';
    open.title = c.firstTask || '(no task)';
    const outcome = c.outcome ?? 'unfinished';
    const meta = el('span', 'chat-meta');
    meta.append(el('span', 'time', c.startedAt.slice(11, 16)), el('span', `outcome ${outcome}`, outcomeLabel(c.outcome)));
    open.append(el('span', 'chat-title', chatTitle(c.firstTask)), meta);
    open.addEventListener('click', () => void openChat(c));
    const trash = el('button', 'chat-delete');
    trash.type = 'button';
    trash.title = 'Delete this chat';
    trash.setAttribute('aria-label', 'Delete this chat');
    trash.innerHTML = TRASH;
    confirmOnce(
      trash,
      () => 'Delete?',
      async () => {
        try {
          await deps.ask('chats.delete', { name: c.name });
          chats = chats.filter((x) => x.name !== c.name);
          renderHistory();
          setNote(historyNote, '');
        } catch (err) {
          setNote(historyNote, `Could not delete it: ${msg(err)}`, 'error');
        }
      },
    );
    row.append(open, trash);
    return row;
  };

  const openChat = async (c: ChatInfo) => {
    const gen = generation;
    setNote(historyNote, 'Opening…');
    try {
      const r = await deps.ask('chats.open', { name: c.name });
      if (gen !== generation) return;
      close();
      deps.showPast(r.info, r.items);
    } catch (err) {
      if (gen === generation) setNote(historyNote, `Could not open it: ${msg(err)}`, 'error');
    }
  };

  historyFilter.addEventListener('input', renderHistory);
  confirmOnce(
    deleteAll,
    () => `Delete all ${chats.length} past chat${chats.length === 1 ? '' : 's'}? Click again`,
    async () => {
      try {
        const n = await deps.ask('chats.delete');
        chats = [];
        renderHistory();
        setNote(historyNote, `Deleted ${n} past chat${n === 1 ? '' : 's'}. Her journal, facts and self are not touched.`, 'ok');
      } catch (err) {
        setNote(historyNote, `Could not delete them: ${msg(err)}`, 'error');
      }
    },
  );

  const openHistory = async (gen: number) => {
    historyFilter.value = '';
    historyList.replaceChildren();
    setNote(historyNote, 'Loading…');
    try {
      const list = await deps.ask('chats.list');
      if (gen !== generation) return;
      chats = list;
      setNote(historyNote, '');
      renderHistory();
      if (chats.length) historyFilter.focus();
    } catch (err) {
      if (gen === generation) setNote(historyNote, `Could not list past chats: ${msg(err)}`, 'error');
    }
  };

  /* ---------- Settings ---------- */

  const settingsFields = $<HTMLDivElement>('settingsFields');
  const settingsNote = $<HTMLParagraphElement>('settingsNote');
  const settingsSave = $<HTMLButtonElement>('settingsSave');
  let schema: SettingsSchema | undefined;
  type Field = { entry: SettingsEntry; get: () => FieldInput; control: HTMLElement; box: HTMLElement; error: HTMLElement };
  let form: { opened: DeskfishConfig; fields: Field[] } | undefined;
  let saving = false;

  const renderField = (e: SettingsEntry, cfg: DeskfishConfig, fields: Field[]): HTMLElement => {
    const box = el('div', 'field');
    const id = `setting-${e.key}`;
    const error = el('p', 'hint error');
    error.hidden = true;
    let control: HTMLInputElement | HTMLSelectElement;
    let get: () => FieldInput;
    if (e.type === 'boolean') {
      const input = el('input');
      input.type = 'checkbox';
      input.id = id;
      input.checked = fieldInput(e, cfg) === true;
      const label = el('label', 'check');
      label.append(input, document.createTextNode(settingLabel(e.setting)));
      box.append(label);
      control = input;
      get = () => input.checked;
    } else {
      const label = el('label', undefined, settingLabel(e.setting));
      label.htmlFor = id;
      label.append(el('span', 'setting-id', e.setting));
      box.append(label);
      if (e.enum) {
        const select = el('select');
        e.enum.forEach((v, i) => {
          const o = el('option', undefined, v || 'default');
          o.value = v;
          if (e.enumDescriptions?.[i]) o.title = e.enumDescriptions[i];
          select.append(o);
        });
        select.value = String(fieldInput(e, cfg));
        control = select;
        get = () => select.value;
      } else {
        const input = el('input');
        input.type = e.type === 'number' ? 'number' : SECRET_SETTINGS.has(e.key) ? 'password' : 'text';
        if (e.type === 'number') {
          input.step = 'any';
          if (e.minimum !== undefined) input.min = String(e.minimum);
          if (e.maximum !== undefined) input.max = String(e.maximum);
        }
        if (e.nullable) input.placeholder = 'not set';
        input.autocomplete = 'off';
        input.spellcheck = false;
        input.value = String(fieldInput(e, cfg));
        control = input;
        get = () => input.value;
      }
      control.id = id;
      box.append(control);
    }
    box.append(error);
    if (e.description) box.append(el('p', 'hint', e.description));
    if (e.enumDescriptions && control instanceof HTMLSelectElement) {
      const select = control;
      const which = el('p', 'hint');
      const show = () => (which.textContent = e.enumDescriptions![e.enum!.indexOf(select.value)] ?? '');
      select.addEventListener('change', show);
      show();
      box.append(which);
    }
    fields.push({ entry: e, get, control, box, error });
    return box;
  };

  const openSettings = async (gen: number) => {
    form = undefined;
    settingsFields.replaceChildren();
    setNote(settingsNote, 'Loading…');
    settingsSave.disabled = true;
    try {
      const [sch, cfg] = await Promise.all([schema ? Promise.resolve(schema) : deps.ask('config.schema'), deps.ask('config.get')]);
      if (gen !== generation) return;
      schema = sch;
      const fields: Field[] = [];
      const groups: HTMLElement[] = [];
      for (const group of ['work', 'desktop', 'remote', 'advanced'] as const) {
        const entries = sch.filter((e) => e.group === group);
        if (!entries.length) continue;
        const section = group === 'advanced' ? el('details', 'group') : el('section', 'group');
        section.append(group === 'advanced' ? el('summary', undefined, GROUP_TITLES[group]) : el('h3', undefined, GROUP_TITLES[group]));
        for (const e of entries) section.append(renderField(e, cfg, fields));
        groups.push(section);
      }
      settingsFields.replaceChildren(...groups);
      form = { opened: cfg, fields };
      setNote(settingsNote, '');
      settingsSave.disabled = false;
    } catch (err) {
      if (gen === generation) setNote(settingsNote, `Could not read the settings: ${msg(err)}`, 'error');
    }
  };

  const refuse = (f: Field, text: string) => {
    f.error.textContent = text;
    f.error.hidden = false;
    f.box.classList.add('refused');
    const folded = f.box.closest('details');
    if (folded) folded.open = true;
    f.control.focus();
    f.box.scrollIntoView({ block: 'nearest' });
  };

  /**
   * Save: only what the person changed since the panel opened goes out (a value another client set
   * meanwhile is not sent back), never the model's three keys (the Change button's). The header
   * re-renders from the `config` event, as for any client's change.
   */
  const saveSettings = async () => {
    if (saving || !form || !schema) return;
    const { opened, fields } = form;
    for (const f of fields) {
      f.error.hidden = true;
      f.box.classList.remove('refused');
    }
    setNote(settingsNote, '');
    const values: Record<string, unknown> = { ...opened };
    let bad: Field | undefined;
    for (const f of fields) {
      const r = readField(f.entry, f.get());
      if ('error' in r) {
        bad ??= f;
        f.error.textContent = r.error;
        f.error.hidden = false;
        f.box.classList.add('refused');
      } else values[f.entry.key] = r.value;
    }
    if (bad) return refuse(bad, bad.error.textContent ?? '');
    const keys = schema.filter((e) => e.group !== 'model').map((e) => e.key);
    const patch = patchBetween(opened, values as unknown as DeskfishConfig, keys);
    if (!Object.keys(patch).length) return close();
    saving = true;
    settingsSave.disabled = true;
    setNote(settingsNote, 'Saving…');
    let refusal: SettingsRefusal | undefined;
    try {
      await deps.ask('config.set', { patch });
    } catch (err) {
      refusal = refusalOf(msg(err));
    }
    saving = false;
    settingsSave.disabled = false;
    setNote(settingsNote, '');
    if (!refusal) return close();
    const f = refusal.key ? fields.find((x) => x.entry.key === refusal.key) : undefined;
    if (f) refuse(f, refusal.message);
    else setNote(settingsNote, refusal.message, 'error');
  };

  settingsSave.addEventListener('click', () => void saveSettings());
  $('settingsCancel').addEventListener('click', close);
  // No <form> (a password field in a form makes a browser offer to keep it as a login): Enter in a field saves.
  sections.settings.addEventListener('keydown', (ev) => {
    const t = ev.target as HTMLElement;
    if (ev.key === 'Enter' && t.tagName === 'INPUT' && (t as HTMLInputElement).type !== 'checkbox') {
      ev.preventDefault();
      void saveSettings();
    }
  });

  /* ---------- Scheduled tasks ---------- */

  const scheduleList = $<HTMLUListElement>('scheduleList');
  const scheduleEmpty = $<HTMLParagraphElement>('scheduleEmpty');
  const schedNote = $<HTMLParagraphElement>('schedNote');
  const kind = $<HTMLSelectElement>('schedKind');
  const at = $<HTMLInputElement>('schedAt');
  const day = $<HTMLSelectElement>('schedDay');
  const time = $<HTMLInputElement>('schedTime');
  const minutes = $<HTMLInputElement>('schedMinutes');
  const task = $<HTMLTextAreaElement>('schedTask');
  const autonomy = $<HTMLSelectElement>('schedAutonomy');
  const budget = $<HTMLInputElement>('schedBudget');
  const addButton = $<HTMLButtonElement>('schedAdd');
  WEEKDAYS.forEach((name, i) => {
    const o = el('option', undefined, name);
    o.value = String(i);
    day.append(o);
  });
  const showKind = () => {
    const k = kind.value;
    $('schedAtRow').hidden = k !== 'once';
    $('schedDayRow').hidden = k !== 'weekly';
    $('schedTimeRow').hidden = k !== 'daily' && k !== 'weekly';
    $('schedEveryRow').hidden = k !== 'every';
  };
  const showAutonomy = () => ($('schedAutonomyDetail').textContent = AUTONOMY_DETAILS[autonomy.value === 'free' ? 'free' : 'guided']);
  kind.addEventListener('change', showKind);
  autonomy.addEventListener('change', showAutonomy);

  const scheduleRows = (list: { schedules: { id: string; task: string }[]; lines: string[] }) => {
    scheduleEmpty.hidden = list.schedules.length > 0;
    scheduleList.replaceChildren(
      ...list.schedules.map((s, i) => {
        const li = el('li');
        const line = el('span', 'line', list.lines[i] ?? s.task);
        const run = el('button', 'btn', 'Run now');
        run.type = 'button';
        // The chat shows the run: the panel gets out of the way (a busy gateway queues it and says so in the chat).
        run.addEventListener('click', () => {
          close();
          void deps.ask('schedules.runNow', { id: s.id }).catch(() => undefined);
        });
        const remove = el('button', 'btn', 'Remove');
        remove.type = 'button';
        confirmOnce(
          remove,
          () => 'Remove?',
          async () => {
            try {
              await deps.ask('schedules.remove', { id: s.id });
              await refreshSchedules();
            } catch (err) {
              setNote(schedNote, `Could not remove it: ${msg(err)}`, 'error');
            }
          },
        );
        li.append(line, run, remove);
        return li;
      }),
    );
  };

  const refreshSchedules = async () => {
    const gen = generation;
    try {
      const list = await deps.ask('schedules.list');
      if (gen === generation && current === 'schedules') scheduleRows(list);
    } catch (err) {
      if (gen === generation) setNote(schedNote, `Could not list the scheduled tasks: ${msg(err)}`, 'error');
    }
  };

  /** Add from the form: the questions VS Code used to ask one by one, checked here first and by the gateway again. */
  const addSchedule = async () => {
    const f: ScheduleForm = { kind: kind.value as ScheduleForm['kind'], at: at.value, day: day.value, time: time.value, minutes: minutes.value, task: task.value, autonomy: autonomy.value === 'free' ? 'free' : 'guided', budget: budget.value };
    const when = whenFromFields(f);
    if ('error' in when) return setNote(schedNote, when.error, 'error');
    const text = f.task.trim();
    if (!text) return setNote(schedNote, 'Say what she should do.', 'error');
    const b = parseBudget(f.budget);
    if (b === 'bad') return setNote(schedNote, 'The budget is a number of dollars, 0 or more — or empty for the setting.', 'error');
    addButton.disabled = true;
    setNote(schedNote, '');
    try {
      const s = await deps.ask('schedules.add', { task: text, when: when.when, autonomy: f.autonomy, ...(b !== undefined ? { maxCostUsd: b } : {}) });
      const list = await deps.ask('schedules.list');
      scheduleRows(list);
      // The next schedule starts from the defaults again (guided, the setting's budget); when and how often stay.
      task.value = '';
      budget.value = '';
      autonomy.value = 'guided';
      showAutonomy();
      setNote(schedNote, `Added: ${list.lines[list.schedules.findIndex((x) => x.id === s.id)] ?? s.task}`, 'ok');
    } catch (err) {
      setNote(schedNote, `Could not schedule: ${msg(err)}`, 'error');
    } finally {
      addButton.disabled = false;
    }
  };
  addButton.addEventListener('click', () => void addSchedule());

  const openSchedules = async (gen: number) => {
    kind.value = 'once';
    at.value = inAnHour();
    day.value = '1';
    time.value = '09:00';
    minutes.value = '60';
    task.value = '';
    autonomy.value = 'guided';
    budget.value = '';
    showKind();
    showAutonomy();
    setNote(schedNote, '');
    scheduleList.replaceChildren();
    scheduleEmpty.hidden = true;
    $('schedBudgetHint').textContent = '';
    try {
      const [list, cfg] = await Promise.all([deps.ask('schedules.list'), deps.ask('config.get')]);
      if (gen !== generation) return;
      scheduleRows(list);
      $('schedBudgetHint').textContent = budgetHint(cfg.unattendedMaxCostUsd);
    } catch (err) {
      if (gen === generation) setNote(schedNote, `Could not list the scheduled tasks: ${msg(err)}`, 'error');
    }
  };

  /* ---------- Her files ---------- */

  type Tab = 'memory' | 'charter' | 'self' | 'journal' | 'playbooks';
  const filesBody = $<HTMLDivElement>('filesBody');
  const filesNote = $<HTMLParagraphElement>('filesNote');
  const forget = $<HTMLButtonElement>('filesForget');
  const edit = $<HTMLButtonElement>('filesEdit');
  const save = $<HTMLButtonElement>('filesSave');
  const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>('#filesTabs [data-tab]'));
  let tab: Tab = 'memory';
  let facts = 0;
  let editor: HTMLTextAreaElement | undefined;
  const renderForget = () => {
    forget.textContent = facts ? `Forget all ${facts} fact${facts === 1 ? '' : 's'}` : 'No facts to forget';
    forget.disabled = !facts;
  };
  const fileOf = (t: Tab) => (t === 'charter' ? 'charter.md' : 'memory.md') as 'memory.md' | 'charter.md';

  /** A read-only page of hers: escaped, with bold, code, headings and links. */
  const page = (text: string, empty: string): HTMLElement => {
    const doc = el('div', 'doc');
    if (text.trim()) doc.innerHTML = mdLite(text);
    else doc.textContent = empty;
    return doc;
  };

  const showTab = async (next: Tab) => {
    tab = next;
    const gen = ++generation;
    for (const b of tabs) b.setAttribute('aria-selected', String(b.dataset.tab === next));
    const editable = next === 'memory' || next === 'charter';
    forget.hidden = next !== 'memory';
    edit.hidden = !(editable && deps.host === 'vscode');
    save.hidden = !(editable && deps.host === 'web');
    editor = undefined;
    filesBody.replaceChildren();
    setNote(filesNote, 'Loading…');
    try {
      if (editable) {
        const r = await deps.ask('memory.read', { file: fileOf(next) });
        if (gen !== generation) return;
        if (next === 'memory') {
          facts = r.facts;
          renderForget();
        }
        const intro = el('p', 'hint', next === 'memory' ? 'The facts she keeps about you and her work, one per line. She adds and forgets them herself; you can too.' : 'The rules she reads before every task. The default text stands until you write your own.');
        if (deps.host === 'web') {
          editor = el('textarea', 'editor');
          editor.value = r.text;
          editor.spellcheck = false;
          editor.setAttribute('aria-label', next === 'memory' ? 'Her facts' : 'Her charter');
          filesBody.replaceChildren(intro, editor);
        } else {
          filesBody.replaceChildren(intro, page(r.text, '(empty)'));
        }
      } else if (next === 'self') {
        const text = await deps.ask('self.read');
        if (gen !== generation) return;
        // The first line says who wrote the page and whether her signature still holds.
        const m = /^> (.*)\n\n?/.exec(text);
        const sig = el('p', `signature${m && /Changed outside her own writing/.test(m[1]) ? ' tampered' : ''}`);
        if (m) sig.innerHTML = mdLite(m[1]);
        filesBody.replaceChildren(...(m ? [sig] : []), page(m ? text.slice(m[0].length) : text, '(nothing written yet)'));
      } else {
        const text = await deps.ask(next === 'journal' ? 'journal.read' : 'playbook.read');
        if (gen !== generation) return;
        filesBody.replaceChildren(page(text, next === 'journal' ? 'Her journal is empty so far.' : 'No playbooks yet. She writes one when she learns how a site or a job works.'));
        // The journal's newest entries are at its end.
        if (next === 'journal') filesBody.scrollTop = filesBody.scrollHeight;
      }
      setNote(filesNote, '');
    } catch (err) {
      if (gen === generation) setNote(filesNote, `Could not read it: ${msg(err)}`, 'error');
    }
  };

  for (const b of tabs) b.addEventListener('click', () => void showTab(b.dataset.tab as Tab));
  edit.addEventListener('click', () => deps.post({ type: 'openFile', file: fileOf(tab) }));
  save.addEventListener('click', async () => {
    if (!editor) return;
    const file = fileOf(tab);
    save.disabled = true;
    setNote(filesNote, 'Saving…');
    try {
      await deps.ask('memory.write', { file, text: editor.value });
      setNote(filesNote, 'Saved.', 'ok');
      if (file === 'memory.md') {
        facts = (await deps.ask('memory.read', { file })).facts;
        renderForget();
      }
    } catch (err) {
      setNote(filesNote, `Could not save: ${msg(err)}`, 'error');
    } finally {
      save.disabled = false;
    }
  });
  confirmOnce(
    forget,
    () => `Forget all ${facts}? Click again`,
    async () => {
      try {
        const n = await deps.ask('memory.clearFacts');
        await showTab('memory');
        setNote(filesNote, `${n} fact${n === 1 ? '' : 's'} forgotten. Her self file and her journal are not touched.`, 'ok');
      } catch (err) {
        setNote(filesNote, `Could not forget them: ${msg(err)}`, 'error');
      }
    },
    () => renderForget(),
  );

  /* ---------- opening ---------- */

  return {
    get current() {
      return current;
    },
    open(panel) {
      if (current && current !== panel) sections[current].hidden = true;
      const was = current;
      current = panel;
      sections[panel].hidden = false;
      if (!was) deps.toggled(true);
      const gen = ++generation;
      if (panel === 'history') void openHistory(gen);
      else if (panel === 'settings') void openSettings(gen);
      else if (panel === 'schedules') void openSchedules(gen);
      else void showTab(tab);
      sections[panel].querySelector<HTMLElement>('.panel-body')?.scrollTo?.(0, 0);
    },
    close,
    schedulesMayHaveChanged() {
      if (current === 'schedules') void refreshSchedules();
    },
  };
}
