/** Corrections verified against the implementation. Only the website copy changes. */
const corrections = {
  'getting-started.md': [
    [
      'single memory, and either of them can talk to one on a server instead.',
      'single memory. To reach one on a server, use its web page or the VS Code extension; the app does not yet have a remote-gateway setting.',
    ],
  ],
  'watching-and-taking-over.md': [
    [
      'The live view is for you. The agent does not watch a video: it takes one screenshot per\nstep and decides from that.',
      'The live view is for you. The agent does not watch a video: it uses screenshots after actions that may change the screen, or when it explicitly asks for a fresh look. Passive reads can continue without another screenshot.',
    ],
  ],
  'models-and-providers.md': [
    [
      'Each step sends the model the task, the conversation so far, the newest screenshot (a JPEG\nof about 1280 × 800 pixels) and the results of its last actions.',
      'Each step sends the model the task, the conversation so far and the results of its last actions. A fresh tank screenshot is included after actions that may change the screen, or when the agent asks for one; passive reads do not add another picture.',
    ],
  ],
};

export function applyContentOverrides(file, body) {
  for (const [before, after] of corrections[file] ?? []) {
    if (!body.includes(before)) {
      throw new Error(
        `Review the website correction for ${file}: its source paragraph changed.`,
      );
    }
    body = body.replace(before, after);
  }
  return body;
}
