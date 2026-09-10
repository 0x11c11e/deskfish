/** Reads the project's public documentation; writes only inside site/. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { render, parseFrontmatter } from './markdown.mjs';
const site = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const docs = path.join(site, '..', 'docs');
const order = [
  'Start here',
  'Using Deskfish',
  'Under the hood',
  'Reference',
  'Help',
];
const pages = fs
  .readdirSync(docs)
  .filter((f) => f.endsWith('.md'))
  .map((file) => {
    const { meta, body: original } = parseFrontmatter(
      fs.readFileSync(path.join(docs, file), 'utf8'),
    );
    let body = original;
    // Bring the website's copy into line with src/config.ts, loop.ts and prompts.ts.
    // Canonical project documentation is deliberately untouched.
    body = body.replace(
      'the step limit, `deskfish.maxSteps`, 60 by default;',
      'an optional step limit, `deskfish.maxSteps`, with no limit by default;',
    );
    body = body.replaceAll(
      'Only the three most recent screenshots stay',
      'After each batch prune, only the three most recent screenshots stay',
    );
    body = body.replace(
      'Only the three most recent images stay in the conversation; older ones are replaced by the',
      'Images are pruned in batches, keeping the most recent three after each prune; older ones are replaced by the',
    );
    body = body.replace(
      'only the three most recent images are kept in the conversation;',
      'older images are pruned in batches, keeping the most recent three after a prune;',
    );
    body = body.replace(
      'It is instructed never to try. It knocks on the glass and you solve it.',
      'It can knock on the glass when it cannot get past a CAPTCHA. Guided mode explicitly tells it to hand these checks to you.',
    );
    body = body.replace(
      'Passwords are never stored.',
      'The agent is instructed to keep passwords out of its memory notes; Firefox may store saved logins inside the tank.',
    );
    body = body.replace(
      'and it never contains a password.',
      'and the agent is instructed to leave passwords out.',
    );
    body = body.replace(
      'nothing it does can reach outside\nthe box unless you carry it out yourself.',
      'host folders are not mounted into its desktop. Files move with Attach and Save; the Desktop tab also shares your clipboard when you focus or paste into it.',
    );
    body = body.replace(
      "the results of the agent's actions, and the documentation pages it reads.",
      "the results of the agent's actions, relevant memory notes, and the documentation pages it reads.",
    );
    if (file !== 'settings.md') {
      body = body
        .replaceAll('`claude-opus-5`', '`<your-computer-use-model>`')
        .replaceAll('`grok-4`', '`<your-vision-and-tools-model>`')
        .replaceAll('`llama3.2-vision`', '`<your-vision-and-tools-model>`');
    }
    if (file === 'getting-started.md') {
      body = body.replace(
        'Deskfish is currently installed from a `.vsix` file built from the source tree. You need\nNode.js 20 or newer.',
        'Download the [Deskfish v0.1.0 extension](/downloads/deskfish-0.1.0.vsix). In VS Code, open Extensions, choose **Install from VSIX…** from the **…** menu, and select the downloaded file.\n\nIf you have the source tree and prefer to build the extension yourself, run these commands from the project root. Building the extension needs Node.js 20 or newer.',
      );
    }
    const page = {
      slug: file.replace('.md', ''),
      title: meta.title,
      description: meta.description,
      section: meta.section,
      order: Number(meta.order),
      body,
    };
    return { ...page, ...render(body, page) };
  })
  .sort(
    (a, b) =>
      order.indexOf(a.section) - order.indexOf(b.section) || a.order - b.order,
  );
fs.mkdirSync(path.join(site, 'app/content'), { recursive: true });
fs.writeFileSync(
  path.join(site, 'app/content/docs.json'),
  JSON.stringify(pages),
);
fs.writeFileSync(
  path.join(site, 'public/sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${['', 'docs/', ...pages.map((p) => 'docs/' + p.slug + '/')].map((p) => `<url><loc>https://deskfish.sh/${p}</loc></url>`).join('')}</urlset>`,
);
console.log(`Synced ${pages.length} documentation pages into site.`);
