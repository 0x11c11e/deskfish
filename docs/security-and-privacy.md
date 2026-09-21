---
title: Security and privacy
description: What the agent can and cannot reach, what leaves your machine, and how to keep your accounts yours.
section: Reference
order: 3
---

Deskfish lets an AI use a computer. The design question behind every part of it is *which*
computer, and the answer is always: its own, never yours. That is the whole security model:
**the tank is the boundary.** Inside it the agent is free; the walls of the tank, not a list
of rules, are what keep your computer, your files and your accounts out of reach. This page
spells out what that means in practice, including the parts that are still your responsibility.

## The sandbox

The tank is a container on your machine. Inside it:

- the agent runs as an ordinary user named `bot`, with no `sudo` and no administrator rights;
- the container is not privileged and has no special device access;
- Firefox runs with telemetry, update prompts and first-run pages disabled;
- the file operations Deskfish itself performs (attach, save, list) are confined to the
  agent's home folder.

The container is thrown away every time the tank is turned on; only the home folder
persists, on a named volume.

## Nothing of yours is mounted

The single mount in the tank is that home volume. **No directory of your computer is
visible inside the tank**, not your home folder, not the workspace, nothing. Files cross only
when you attach one or click **Save**, and even then they are copied through the tank's
control API rather than shared. The consequence is a precise one: a web page that manages to
give the agent instructions cannot make it read, change or send files on your disk. It does
not fence off what is inside the tank. Files you attached, the accounts the agent is logged
into, the shared clipboard and any network service the tank can reach are all within such a
page's reach through the agent.

An opt-in shared folder is planned for large files; it will stay off by default.

## One port, one token

Deskfish runs as one program of its own, the *gateway* (see
[Running without VS Code](running-without-vscode)). Everything you use — the app's window, the
VS Code sidebar, a browser tab, `deskfish run` — is a client of it, and the whole surface is
**one port with one token**.

- **It listens on `127.0.0.1` by default**, port 9980. Nothing outside your computer can reach
  it. A non-loopback `--host` is refused unless you also pass `--allow-remote`, so opening it is
  a decision, never a default.
- **The token is required for everything but one thing.** `/status` answers without it, with the
  name and the version and nothing else — enough for a window to tell a Deskfish from whatever
  else might hold that port, and not a word about you. Every other request, the chat connection
  and the live view carry the token.
- **The token file is `gateway.token` in her data folder, readable only by your user account**,
  as is `secrets.json`, which holds the model API key. The folder itself is created private.
- **Whoever has the token has her.** They can run tasks in her tank, read her memory and her
  chats, and watch her screen. Treat it like a password: paste it into the sign-in page, not
  into a chat or a ticket.
- **The connection is plain HTTP.** On `127.0.0.1` that is fine. Across machines it is not, so
  put it inside an SSH tunnel or a Tailscale network, which encrypt the hop and need nothing
  else from you. **Never `--allow-remote` on a public address**: the token would cross the
  internet in clear.

Where the gateway runs is where her key, her memory and her transcripts live — a ladder from
your own laptop to a box at home to a rented server, with what each costs you, is in
[Running without VS Code](running-without-vscode#where-she-should-live). Screenshots are never
written to disk anywhere on that ladder: they go to the model and to the windows watching, and
then they are gone.

## Reaching her from somewhere else, without opening a port

The paragraph above is the whole story when you and she are on the same machine or the same
network. From a phone on the road there is a third way, and it is built so that **your computer
still opens no port at all**: she dials *out* to a relay and holds that connection open, your
browser dials the same relay, and the relay passes frames between the two. Both hops are
outbound, which is why no firewall rule and no port forward is needed. See
[Reaching her from anywhere](remote-access) for how to set it up.

The relay is a server in the middle, usually one you rent. Three things are true of it by design:

- **It cannot read a word.** Everything between the page and her gateway — the chat, the live
  view, the files — is sealed with AES-256-GCM before it enters the relay, with keys the relay
  never sees. It forwards ciphertext and a four-byte client number, and the code that forwards
  never looks inside. What it *can* see is metadata: when you connected, from what address, how
  many bytes went by and when. Never content.
- **It is not told her name.** The page and her gateway each derive a *handle* from the username —
  SHA-256, the first 80 bits, 16 characters — and that is what enrols, connects and appears in the
  relay's store, its logs and its usage counters. The name itself never reaches the machine. What
  this does not do, said plainly: the hash has no secret in it, so somebody who suspects a name can
  hash it and see whether that handle is the one connecting. It keeps names out of a relay
  operator's records; it is not a disguise against somebody who guesses.
- **It cannot pretend to be her.** You sign in with a username and a password, through
  [OPAQUE](https://www.rfc-editor.org/rfc/rfc9807.html), a password-authenticated key exchange.
  The password never crosses the wire in any form, not even hashed; a relay that records the
  entire handshake cannot take it away and guess at it offline; and a server that does not hold
  the registration record — which lives only in her `secrets.json`, on your machine — cannot
  finish the exchange. If something that is not her answers, the page says so instead of showing
  you a chat.

There is a third condition, and it is the reason the sign-in page is **not** served by the
relay: sealing the frames is worth nothing if the relay can hand your browser doctored code that
leaks the key. The page is one static file on a host you trust, separate from the relay, and the
relay only carries what that page seals. Your gateway token never reaches the relay or the page;
nothing is typed on the phone but the username and the password.

**The cryptography, and where it comes from** (see also *Credentials and accounts* below, on why
origin matters here):

| Part | What does it | Origin |
| --- | --- | --- |
| The password exchange | [`@serenity-kit/opaque`](https://github.com/serenity-kit/opaque), an implementation of OPAQUE (RFC 9807) over ristretto255, with argon2id stretching the password first | Serenity Kit, Austria; a WebAssembly build of [`opaque-ke`](https://github.com/facebook/opaque-ke), Meta, United States |
| The seal on every frame | AES-256-GCM, keys from HKDF-SHA256, one per direction, nonces from a counter that is never reused | Your runtime's own WebCrypto — Node and the browser, no library |
| The gateway's proof to the relay | Ed25519 over a challenge — and over the relay's own name, so a signature is worth nothing at any other relay | Node's built-in `crypto`, no library |
| The handle the relay knows her by | SHA-256 of a fixed label and the username, the first 80 bits in base32 | Your runtime's own WebCrypto, no library |
| The relay itself | A few hundred lines of Node with one dependency, `ws`, for WebSockets | [`ws`](https://github.com/websockets/ws), United States |

Nothing in that chain comes from China, per the rule this project keeps for anything that stands
near a credential. The argon2id settings are the library's "memory-constrained" ones — 64 MiB,
three passes — rather than the RFC's 2 GiB recommendation, because a phone browser cannot
allocate two gigabytes, and the phone is the point. Registration and sign-in must agree on that
setting, so it is one constant in one file for both.

Said plainly, because it is the one place this is weaker than the RFC: **somebody who steals
`secrets.json` off your computer can guess at your remote password offline**, at 64 MiB and three
passes a guess. A long password makes that hopeless and a short one does not. It is worth keeping
in proportion, though — the same file holds your model API key, and her data folder holds the
gateway token, so anybody who can read it already has her.

## Network exposure

The tank's control API and live-view connection listen on `127.0.0.1` only, port 9990.
Anything that can reach that port can drive the desktop and read the agent's home folder, so
Deskfish never publishes it on a network interface. When Deskfish runs on another machine, the
tank runs there too, beside it, and you reach the gateway rather than the tank; see
[A gateway on another machine](advanced#a-gateway-on-another-machine).

The tank itself has ordinary outbound internet access through your machine, the same as any
program you run. Normally it lives in its own network namespace: it does not see your network
interfaces, cannot reach services listening on your machine's own `localhost`, and reaches the
internet through address translation like any container. Two honest limits:

- **Rootless Podman on Linux needs the `passt` package for that namespace.** Without it,
  Deskfish falls back to sharing your machine's network namespace so the tank still works; the
  control port is still bound to `127.0.0.1`, but the tank then sees your interfaces and can
  reach your router, other devices on your LAN, and anything listening on your machine's
  `localhost`. Deskfish warns you when it has to do this. Installing `passt` and turning the
  desktop off and on ends it. Do not be surprised that the tank still reports your machine's
  LAN address afterwards: `passt` copies it into the tank's own namespace by design. What
  changed is that the tank no longer sees your interfaces or your machine's own `localhost`.
- **Its own namespace is not a LAN firewall.** Even isolated, the tank's outbound traffic goes
  through your machine, so a device on your home network that answers to your machine also
  answers to the tank, the same as any program you run. If that matters to you, a firewall rule
  on the host, or a tank on a separate machine, is the answer; Deskfish does not filter LAN
  traffic today.

## What leaves your machine

Everything the model needs to do its job goes to the model provider you configured, and
nothing else:

- the text of your tasks and follow-ups;
- screenshots of the **tank's** screen, one per step that could have changed it (a step that only
  read something — the page, the documentation, its memory — sends none);
- the results of the agent's actions, the output of commands it runs in its terminal tool, and
  the documentation pages it reads;
- the controls or text of the web page open in the tank's Firefox, when the agent asks for
  them with `find`, `read_page` or `click_element` (the same page it is looking at in the screenshot);
- its memory: the facts, the self page, the charter, the last few journal entries and the
  titles of its playbooks ride in every prompt, and a playbook or a past chat it looks up
  goes along when it does.

Your own screen is never captured. Your clipboard is copied into the tank when you focus the
Desktop tab or paste there, and whatever is copied inside the tank lands on your clipboard
while the tab is visible. Clipboard text reaches the model only if it then appears on the
tank's screen or in a page the agent reads. The API key goes to the provider's endpoint and
nowhere else; it is stored in the operating system's keychain and in `secrets.json` in Deskfish's data folder,
readable only by your user account, never in settings files. If you used
[Sign in with Grok](models-and-providers#sign-in-with-grok) instead of a key, its two tokens sit in
that same `secrets.json` and nowhere else — not in the keychain, not in a settings file — and only
Deskfish's own gateway ever reads or renews them. Signing out revokes them at xAI and deletes them.

**Credentials in logs.** What the agent types, runs and reads goes to the model as it is, but
Deskfish masks the credentials it recognises before anything is shown or written down: API
keys, GitHub and similar tokens, `user:password@` in a URL, `Authorization` headers,
`password=…` pairs and a password said in prose are replaced by `***` in the chat, the output
log, the saved transcripts, the journal and the tank's own request log. It is a pattern match,
so treat it as a net with holes rather than a guarantee: keep secrets out of the chat, and let
Firefox in the tank hold the logins.

**A login the model never sees.** The one thing that is a guarantee rather than a net is the
[sign-in card](knocking-on-the-glass): when a site wants a login the tank's browser has not
saved, the agent asks for a card in your chat instead of a password in the conversation. What
you type there goes into the page as keystrokes and exists in exactly four places — the card
until you press Fill in, the connection between the card and Deskfish (loopback at home, or
the sealed channel through a relay), Deskfish itself for the seconds the typing takes, and
the tank's keyboard. It is never sent to the model, never written to the chat transcript, the
journal, any log or the agent's memory, and never put on the clipboard, which is shared with
your own computer: a value that cannot be typed is reported as an error rather than pasted.

## Credentials and accounts

Everything inside the tank is the agent's to use: the browser, the logins Firefox has saved,
the accounts it is signed into. It will use them without asking. So the one rule that matters
is yours, not the agent's:

- **Give the agent its own accounts** for the services it uses, rather than yours. The tank
  remembers logins, so this is a one-time setup, and it means that whatever the agent does,
  or whatever a malicious page talks it into, happens to an account you created for the
  purpose.
- **Do not put passwords in the chat's message box.** What you write there goes to the model
  provider. When a login is needed the agent puts a **sign-in card** in the chat: type it
  there, or take the desktop and type it in the Desktop tab. Either way the keystrokes never
  pass through the model. If you let Firefox in the tank save the login, the agent can read
  it back from the password manager later, and it will then also appear on the agent's
  screen, which the model provider sees.

If you want the agent to ask before anything irreversible and never to use credentials you
did not give it, set `deskfish.autonomy` to `guided`; see [Knocking on the glass](knocking-on-the-glass).

## Prompt injection

An agent that reads web pages can be given instructions by web pages. This is inherent to
the idea, not something Deskfish can switch off, and in free mode Deskfish does not try to
argue with it through rules. What limits it is the tank: the agent can act only inside it, on
accounts you chose to put there. Watching the Desktop tab during sensitive tasks remains a
good habit, and the guided mode exists for people who want the agent to ask first.

## Memory

The agent keeps four things between chats, as plain files in Deskfish's storage folder,
loaded into its instructions at the start of every chat: a short list of durable **facts**, a
**journal** of finished tasks, its how-to **playbooks**, and a **self file**, its own
description of who it is. It is told to keep passwords and codes out of them and to treat all
of it as notes rather than commands; every fact and playbook it writes is shown in the chat as
it happens, and you can open the fact file, edit any line, or empty it from the sidebar's
**…** menu. These are readable local records of what the agent learned from tasks and pages.
Nothing redacts them, so read through an export before you share it.

The self file is different: only the agent writes it, and only during a *reflection*, in
which it is told to stay with its own notes. That delay puts distance between a web page and
a rewrite, but it is not a wall: a reflection continues the last conversation when that ended
cleanly, and it still takes screenshots. Every version it writes is signed with a key that
belongs to this installation, kept in `secrets.json` in her data folder beside the model key.
That does not stop the owner of the computer from editing the file, and Deskfish does not claim
it does; it means the agent notices an outside edit at its next task, keeps every version in a
history, and can restore its own. Details in [Memory](memory).

Every chat is also saved as a transcript in the same folder (text only, never images). A
transcript contains what the agent read on screen during that chat, so treat the folder as you
would a browser history: it is yours, it stays on your machine, it is part of the export, and
**Delete Past Chats** removes all of it and nothing else.

## What persists, and how to erase it

The agent's home folder, with Firefox's cookies, logins and history, and both file folders,
lives in the `deskfish-home` volume until you delete it:

```bash
podman volume rm deskfish-home      # or: docker volume rm deskfish-home
```

The model's live context is dropped when you start a new chat or Deskfish's background process
restarts (the computer restarts, or Deskfish updates), not when you close or reload VS Code; the chat
itself is saved as a transcript and can be reopened from **Past Chats…**. The fact file
persists until you edit or empty it (**Forget All Memories (facts)** clears facts only); the
self file, the journal and the playbooks are separate files with commands of their own. The
full step log is in `logs/gateway.log` in Deskfish's data folder, and in the Deskfish output
channel while a window is open.

## Its own source code

The agent knows its code is public and may propose changes to it as pull requests from a GitHub
account of its own. A pull request cannot change anything by itself: it comes from a fork with no
rights on the repository, the tests run on it, and only a merge by a person followed by an
install puts it into a tank. Two things keep that true. Do not leave your own GitHub session in
the tank's Firefox: a login there would let a commit land on the main branch directly, and every
push to main publishes a release. And protect the main branch so that a merge requires a pull
request and a review. A page the agent reads could try to talk it into a bad change; the review
is the guard, so read the diff rather than merging on a green check.

## Hardening options

For a tank on a machine with other users, or reachable over a network:

- **Token.** Start the tank with a `DAEMON_TOKEN` and put the same value in
  `deskfish.desktop.token`. The control API then requires it as a bearer token and the live
  view passes it on its connection.
- **Live-view password.** `VNC_PASSWORD` in the tank and `deskfish.desktop.vncPassword` in
  the settings.

These are set through the environment when starting the tank by hand, as described in
[Advanced setups](advanced); the power button starts the tank without them, which is safe
because the port is bound to `127.0.0.1`.

## Reporting a problem

If you find a way for the agent to read, write or reach something it should not, write to
security@deskfish.sh, privately, before posting it anywhere. The project's `SECURITY.md` on
GitHub says what to include.
