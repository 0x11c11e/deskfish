---
title: Reaching her from anywhere
description: Start a task at your computer, carry on from your phone — through a relay that cannot read a word, with no port open at home.
section: Using Deskfish
order: 8
---

Deskfish runs on your own computer and listens only to that computer. That is the right default
and it is why there is nothing to lock down — but it also means that when you walk away from your
desk, you walk away from her.

This is the way back in: **she dials out**. Her gateway opens a connection to a small program
called a *relay* and holds it. Your browser opens a connection to the same relay. The relay passes
frames between the two. Both connections are outbound, which every home router allows — so **you
still open no port, forward nothing and change no firewall rule**.

You sign in at the page with a username and a password. Nothing else: no token to copy from your
computer onto your phone, no key in a QR code, nothing to lose.

## What the relay can see

Nothing you do. This is worth being precise about, because "end to end encrypted" is a phrase
people say loosely.

- **The frames are sealed before they reach it.** The page and her gateway agree on keys through
  the relay and then speak AES-256-GCM. The relay copies ciphertext and a client number. There is
  no log setting that prints a frame, because there is no code that opens one.
- **The password never crosses the wire.** Sign-in uses [OPAQUE](https://www.rfc-editor.org/rfc/rfc9807.html),
  a password-authenticated key exchange. Not the password, not a hash of it, not anything a machine
  that recorded the whole conversation could take away and guess at afterwards.
- **A relay cannot impersonate her.** Finishing the exchange needs a registration record that never
  leaves your computer. If something that is not her answers, the page tells you so.
- **The page is not served by the relay.** Sealing frames would be worth nothing if the same
  machine could hand your browser altered code that leaks the key. The sign-in page is one static
  file, published separately.
- **It is not told her name either.** A relay has to key its post boxes on something, so the page
  and her gateway each turn the username into a **handle** — a hash, the same at both ends, 16
  characters like `nbh5le2y5dbrwtsx` — and send that. The name you type stays in the browser and on
  your computer; the relay's records, its logs and its usage counters hold the handle. Its limit,
  said plainly: nothing secret goes into the hash, so somebody who suspects a name can hash it and
  see whether that handle is the one connecting. It keeps names out of a relay's records; it does
  not hide a guessable name from somebody who guesses it.

What a relay does see, unavoidably, is metadata: that handle, when you connect, from what
address, and how many bytes go by. It is a post box. It knows an envelope arrived; it cannot open
one.

## What you need

A relay has to be somewhere both of you can reach, which means a machine with a name and a
certificate — a cheap VPS is plenty. You can run your own; the whole program is in `relay/` in the
Deskfish repository, with a README, a Dockerfile and a compose file. One container, one dependency,
one small JSON file of state.

### Where the page goes

The sign-in page is one file, `remote.html`, attached to every [release](https://github.com/0x11c11e/deskfish/releases/latest).
Put it **anywhere except the relay's own machine** — that separation is what the third point above
is about. Two ways that cost nothing:

- **GitHub Pages**, from a repository of your own: commit the file as `index.html`, turn Pages on,
  and your address is `https://<you>.github.io/<repo>/`.
- **Any static host you already use** — the same place a personal site lives.

What does **not** work is keeping the file on the phone and opening it from the Files app: a
phone's browser opens a saved page without a secure context, and the cryptography this page runs
on is not available outside one. It has to be served, over `https://`, from somewhere.

Wherever it lands, the page asks for the relay address once and remembers it in that browser. Put it
at `remote.<your domain>` and it finds `wss://relay.<your domain>` by itself.

## Setting it up, in four steps

**1. Run the relay** on your server and put your TLS proxy in front of it, so it answers at a name
like `relay.example.com`. The [relay README](https://github.com/0x11c11e/deskfish/tree/main/relay)
has Caddy, Traefik and nginx snippets. Give it an admin key of your own:

```bash
printf 'RELAY_ADMIN_KEY=%s\n' "$(openssl rand -base64 32)" > relay.env
```

**2. Mint an enrolment code** with that key. The admin key stays on the server; a code is what
travels. On your own relay, mint one with no name attached — the gateway that spends it claims its
handle:

```bash
curl -s -X POST https://relay.example.com/admin/codes \
  -H "authorization: Bearer $RELAY_ADMIN_KEY" \
  -H 'content-type: application/json' -d '{}'
```

**3. Enrol at home.** In VS Code, run **Deskfish: Remote Access…** and give it the relay address,
the username and the code. It asks for a password twice. Without VS Code:

```bash
deskfish remote enroll --relay wss://relay.example.com --username yourname --code <the code>
deskfish remote password
```

The password is turned into a record on your own machine — both halves of the exchange run
locally — and then forgotten. It is not stored anywhere, so choose one you will remember: there is
nobody to reset it for you, and no code can mint a new one (a code enrols a gateway; only your own
computer can set a password). Run `deskfish remote password` again to change it. The sign-in page
asks for the name and the password as an ordinary login form, so your phone's password manager
offers to keep them — which is the practical answer to remembering a long one.

**4. Open the page** on your phone, type the username and the password, and you are in the same
chat that is open at your desk. A task you started at the computer is running in front of you; a
task you start on the phone is waiting when you get back.

`deskfish remote status` says whether she is connected, how many windows are on her, and — as
*known to the relay as* — the handle. That is the only name the relay has for her, so it is what
you give an operator who asks what to mint a code for; **Deskfish: Remote Access…** copies it.
`deskfish remote off` stops the dial-out; she stays exactly where she is, reachable from your own
computer as before.

## What it costs you to think about

- **The password is the whole lock.** Everything else is arranged so that this is true: no token to
  leak, no port to find, no certificate to compare. Make it a long one. A wrong password is refused
  by her gateway, not by the relay — five tries a minute, then a wait — because only she can tell
  a wrong password from a right one.
- **She has to be running.** The relay holds no state and no messages: if her computer is asleep,
  the page says she is not connected, and that is all it can say.
- **Your model provider still sees everything she sees.** No relay changes that; see
  [Security and privacy](security-and-privacy#what-leaves-your-machine).
- **If you run the relay yourself, you are the operator.** Back up its one JSON file, keep the
  admin key off the internet, and read the README's last section before you ever run one for
  somebody else.

## If you would rather not have a server in the middle

You do not have to. An SSH tunnel or a Tailscale network reaches her too, and both are covered in
[Advanced setups](advanced#a-gateway-on-another-machine). They ask more of the device you are
holding — a client to install, a key to carry — which is the trade: a relay asks nothing of the
phone but a browser.
