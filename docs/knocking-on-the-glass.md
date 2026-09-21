---
title: Knocking on the glass
description: When and why the agent stops to ask for you, what you see, and what to do.
section: Using Deskfish
order: 4
---

Some things on the web are meant for humans only: your password, the six-digit code on
your phone, the pictures of traffic lights. Deskfish hands them to you. When the agent
reaches one of these, it knocks on the glass.

There are two knocks. Usually it hands you **the desktop**: it stops, tells you what it
needs, and your mouse and keyboard go to the tank. For a login it hands you **a form**
instead — a small card in the chat with the site's fields in it, whose values go straight
into the page without the agent ever seeing them. That one is [the sign-in
card](#the-sign-in-card) below.

## When it knocks

The agent asks for you when it needs something only you have or can do:

- a **code** on your phone, or a confirmation from another device,
- a **card number** or other payment detail that is not already saved on the account,
- a **CAPTCHA** or another "prove you are human" check it cannot get past (in free mode
  nothing forbids it from trying first; in guided mode it never attempts one),
- a confirmation a site insists on from a person,
- or it is **stuck**: the page is not behaving, or it does not understand what to do.

A **login** the browser has not saved is the exception: that one gets the sign-in card, not
the desktop.

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

## The sign-in card

When a page wants a username and a password that the tank's Firefox has not saved, the agent
does not hand you the desktop and does not ask you for the values in the chat. It reads the
form, then puts a card in the chat:

> **✋ Deskfish needs a login**
> Sign in to LinkedIn
> Email or phone ▢  ·  Password ▢  ·  **Fill in**

You type into the card and press **Fill in**. What you typed is typed into the page on the
bot's desktop, key by key, exactly as if you had sat down at it — so the page's own scripts
see a person typing, and Firefox offers to save the login. Then the agent presses the
sign-in button itself and carries on. It is told *"Filled 2 fields into the page (Email or
phone, Password)"* and nothing else: it never receives what you typed.

The password field is masked, and your browser can offer to fill it from its own password
manager, because it is an ordinary password input.

**Where those values go, exactly.** They are in the card until you press Fill in; on the
connection between the card and Deskfish (loopback at your own computer, or the sealed
channel when you are [reaching her from your phone](remote-access)); in
Deskfish for the seconds the typing takes; and in the keystrokes that go to the tank.
Nowhere else, and not afterwards. They are not sent to the model, not written to the chat
transcript, not in the agent's journal, not in any log, and not put on the clipboard — a
secret that cannot be typed is reported as an error rather than pasted, because the
clipboard is shared with your own computer.

The card comes to whichever chat you are in, so a login works the same from VS Code, from
the browser page, and from your phone.

If you would rather type it on the desktop yourself, the card also carries **Open desktop**
and **Resume**, exactly like the knock above. And a second factor is still a knock: if the
site then wants a code, an app approval or a CAPTCHA, the agent hands you the desktop for
that step.

## Log in once

The tank keeps its browser profile between restarts. The first time a site wants a login you
get the sign-in card; because the values were typed as real keystrokes, Firefox offers to
save them; and from then on the site is simply logged in, with no card and no knock, for
weeks. If you let it save the login, the agent can also read it back from Firefox's password
manager later — see [Security and privacy](security-and-privacy), which also explains why
giving the agent accounts of its own is the recommended way to work.

## About your secrets

What you type while you have taken over goes straight to the tank, and so does what you type
into the sign-in card. Neither passes through the chat, and the model never receives your
keystrokes. Two honest caveats:

- The agent's next screenshot shows the screen as you left it. Sites mask passwords in
  their fields, but if a page displays a secret in plain text, close or scroll it away
  before you hand back.
- Anything you write in the **chat itself** does go to the model provider. Use the desktop
  or the sign-in card, never the message box, for passwords and codes.

## Trying it out

With the provider set to `mock`, the demo model knocks once, on purpose, so you can see the
card, the unlocked desktop and the resume flow without any key or account. See
[Models and providers](models-and-providers).
