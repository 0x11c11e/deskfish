/** A scripted illustration of the recorded task; no live browser, API, or purchase. */
export const REPLAY_DURATION = 34_000;
export const DEMO_TASK =
  'Go to Namecheap and buy deskfish.sh. One year, no add-ons. Knock when it’s time to pay.';
export const STILL_SCENES = [0, 8_500, 12_400, 17_400, 27_000];

function type(text: string, time: number, start: number, duration: number) {
  return text.slice(
    0,
    Math.max(
      0,
      Math.min(
        text.length,
        Math.floor(((time - start) / duration) * text.length),
      ),
    ),
  );
}
const pointerStops = [
  { at: 0, target: 'rest', x: 58, y: 59 },
  { at: 4_600, target: 'firefox', x: 46, y: 94 },
  { at: 6_300, target: 'address', x: 43, y: 11 },
  { at: 8_800, target: 'search-input', x: 36, y: 47 },
  { at: 10_700, target: 'search-button', x: 80, y: 47 },
  { at: 13_300, target: 'add-cart', x: 79, y: 65 },
  { at: 15_600, target: 'pay', x: 76, y: 66 },
  { at: 18_000, target: 'rest', x: 86, y: 80 },
  { at: 20_200, target: 'pay', x: 76, y: 66 },
  { at: 23_300, target: 'rest', x: 84, y: 80 },
];
const clicks = [5_250, 6_950, 9_450, 11_350, 13_950, 20_950];
export type ReplayPage =
  | 'blank'
  | 'search'
  | 'results'
  | 'checkout'
  | 'complete';
export function getReplayFrame(time: number) {
  const sent = time >= 3_500;
  const browserOpen = time >= 5_650;
  const page: ReplayPage =
    time < 8_200
      ? 'blank'
      : time < 12_000
        ? 'search'
        : time < 14_700
          ? 'results'
          : time < 22_000
            ? 'checkout'
            : 'complete';
  const handoff = time >= 16_400 && time < 23_400;
  const human = time >= 19_500 && time < 23_400;
  const complete = time >= 26_000;
  const chapter =
    time < 5_650
      ? 0
      : time < 12_000
        ? 1
        : time < 16_400
          ? 2
          : time < 23_400
            ? 3
            : 4;
  const title = [
    'Give it a task',
    'Watch it find a way',
    'Let it do the legwork',
    'A little knock on the glass',
    'A little fish, a home of its own',
  ][chapter];
  const url =
    time < 7_000
      ? 'about:blank'
      : time < 8_200
        ? type('namecheap.com', time, 7_000, 900)
        : time < 12_000
          ? 'namecheap.com'
          : time < 14_700
            ? 'namecheap.com / domains'
            : time < 22_000
              ? 'namecheap.com / checkout'
              : 'namecheap.com / confirmation';
  const pointer =
    pointerStops.findLast((stop) => stop.at <= time) ?? pointerStops[0];
  const click = clicks.find((at) => time >= at && time < at + 420);
  const reply =
    time < 4_150
      ? ''
      : time < 12_000
        ? 'I’ll open Firefox and find the domain.'
        : time < 14_700
          ? 'Found deskfish.sh. One year, no extras. I’ll prepare checkout.'
          : time < 23_400
            ? 'Everything is ready. I’ll hand over for your final click.'
            : time < 26_000
              ? 'I’m checking the confirmation and saving the useful details.'
              : 'All done. deskfish.sh has a new home.';
  const status = complete
    ? 'Task finished'
    : handoff
      ? human
        ? 'Your turn · final click'
        : 'Waiting for you'
      : sent
        ? 'Working in the tank'
        : 'Ready for a little errand';
  return {
    time,
    sent,
    browserOpen,
    page,
    handoff,
    human,
    complete,
    chapter,
    title,
    url,
    pointer,
    click,
    reply,
    status,
    typedTask: type(DEMO_TASK, time, 650, 2_450),
    query: type('deskfish.sh', time, 9_500, 950),
    memory: time >= 24_900,
    actionCount: time < 12_000 ? 3 : time < 14_700 ? 5 : 4,
    sending: time >= 3_300 && time < 3_700,
  };
}
