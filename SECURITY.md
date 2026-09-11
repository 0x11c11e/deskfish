# Security

Deskfish puts an AI agent in a sandboxed desktop and lets it use a browser with the person's
logins. If you find a way for it to read, write or reach something it should not, please tell us
privately first.

**Email:** security@deskfish.sh
**Or:** the *Report a vulnerability* button in this repository's Security tab (private to the maintainer).

Include what you did, what you saw, and what you expected, with the Deskfish version from the
release title and, when it matters, the model and provider in use. Screenshots or a recording of
the tank help a lot. You will get a reply within a few days, a fix as fast as one person can make
it, and credit in the release notes if you want it.

What is in scope: the tank boundary (`docs/security-and-privacy.md` describes what it is and is
not), the control API and live view on `127.0.0.1`, the page bridge in Firefox, the memory and
self files, the way keys are stored, and anything the agent can be talked into by a web page.
What is not: the behaviour of the model itself on ordinary pages, and sites you point it at.

Please do not test against accounts, machines or sites you do not own.
