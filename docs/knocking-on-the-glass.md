---
title: Knocking on the glass
description: When and why the agent stops to ask for you, what you see, and what to do.
section: Using Deskfish
order: 4
---

Some things on the web are meant for humans only: your password, the six-digit code on
your phone, the pictures of traffic lights. Deskfish hands them to you. When the agent
reaches one of these, it knocks on the glass: it stops, tells you what it needs, and hands
you the desktop.

## When it knocks

The agent asks for you when it needs something only you have or can do:

- a **code** on your phone, or a confirmation from another device,
- a **card number** or other payment detail that is not already saved on the account,
- a **CAPTCHA** or another "prove you are human" check it cannot get past (in free mode
  nothing forbids it from trying first; in guided mode it never attempts one),
- a confirmation a site insists on from a person,
- or it is **stuck**: the page is not behaving, or it does not understand what to do.

Inside its own tank it is otherwise free. The tank is the boundary: the browser, its saved
logins, the files and the accounts in it are the agent's to use. If you let Firefox in the
tank remember a login, the agent will read that login from Firefox's password manager and
sign in with it rather than knock. If you ask it to buy something, it goes through checkout.
This is the default, called *free* in `deskfish.autonomy`.

Some people prefer a more cautious agent. Setting `deskfish.autonomy` to **guided** adds
rules: it asks before anything irreversible (paying, sending, posting, deleting) unless the
task explicitly asked for exactly that, it stops before the final Pay click and hands over,
it never uses credentials you did not give it, and it never attempts a CAPTCHA itself.

Note that the model itself may draw lines of its own regardless of this setting. Claude, for
example, tends to stop at the final payment click and hand over even in free mode; the setting
governs what Deskfish asks of the agent, not what the model is willing to do.

## What you see

Three things happen at once:

1. The chat shows a card titled **Deskfish needs you** with the agent's reason in its own
   words, for example *"Please log in to your Booking.com account"*, and a picture of the
   screen at that moment.
2. The Desktop tab opens (if it was not open) and **unlocks**: your mouse and keyboard now
   go to the tank.
3. The status row reads *Paused — Waiting for you: …*.

## What to do

Do the thing on the desktop: type the password, enter the code, solve the puzzle. Then
either

- click **Resume** on the card (or in the composer), or
- simply **type a reply** in the chat, for example *"done"* or *"I logged in, use the
  second account"*. A reply while the agent is waiting counts as *done, carry on*, and your
  words reach the agent with its next screenshot.

The agent is told that you handled it and handed the desktop back, takes a fresh
screenshot, and continues from there.

If you would rather not, **Stop** ends the task.

## About your secrets

What you type while you have taken over goes straight to the tank. It does not pass
through the chat and the model never receives your keystrokes. Two honest caveats:

- The agent's next screenshot shows the screen as you left it. Sites mask passwords in
  their fields, but if a page displays a secret in plain text, close or scroll it away
  before you hand back.
- Anything you write in the **chat** does go to the model provider. Use the desktop, not the
  chat, for passwords and codes.

## Log in once

The tank keeps its browser profile between restarts, so a site you log the agent into stays
logged in. Most sites will not knock again for weeks. This is also why the recommended way
to work is to give the agent accounts of its own; see
[Security and privacy](security-and-privacy).

## Trying it out

With the provider set to `mock`, the demo model knocks once, on purpose, so you can see the
card, the unlocked desktop and the resume flow without any key or account. See
[Models and providers](models-and-providers).
