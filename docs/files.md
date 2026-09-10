---
title: Files in and out
description: Giving the agent a file, and getting files back, without sharing any folder with the tank.
section: Using Deskfish
order: 5
---

The tank shares **no folder** with your computer. Files cross the glass only when you
carry them across: you attach a file to a message, or you click **Save** on a file the agent
produced. This is a security choice, not a limitation to work around: a web page the agent
visits cannot reach files on your disk through a shared folder. It is not the whole story,
since the Desktop tab shares your clipboard and the tank reaches the network like any program
you run; see [Security and privacy](security-and-privacy). The exchange itself is designed to
feel effortless.

## Two folders

Inside the tank, two folders in the agent's home are the crossing points:

| Folder | Direction | Who fills it |
| --- | --- | --- |
| `/home/bot/Uploads` | Your computer → the tank | The paperclip in the composer |
| `/home/bot/Downloads` | The tank → your computer | Firefox, and the agent itself |

The agent knows this arrangement. It looks in Uploads for files you gave it, and it puts
anything meant for you in Downloads.

## Giving the agent a file

1. Click the **paperclip** in the composer. A normal file picker opens; you can choose
   several files.
2. The files are copied into the tank's Uploads folder. They appear above the text box as
   small tags; click **×** on a tag to remove one before sending.
3. Write your task and press Run. The paths of the attached files are added to your message,
   so the agent knows exactly where they are.

Example: attach `cv.pdf` and write *"Upload my CV on the job page at example.com/apply"*.
The agent will use the site's upload button and pick `/home/bot/Uploads/cv.pdf` in the
file dialog.

Attachments need the tank to be on; Deskfish turns it on if necessary. Each file can be up
to 100 MB. File names are kept but sanitized (no path separators or control characters).

## Getting a file from the agent

You do not have to ask. Whenever a new file appears in the tank's Downloads folder, a card
shows up in the chat with the file's name and size and a button that says **Save to your
computer**. Click it, choose where to put the file (the dialog opens in your own Downloads
folder by default, and remembers the last place you chose), and the card changes to
*Saved to …* with a **Show in folder** button.

This works for anything that lands there:

- Files the agent downloads in Firefox. Firefox in the tank is configured to save every
  download straight into Downloads, with no dialog and no "open with" question, so the agent
  never has to deal with a download prompt.
- Files the agent creates itself, for example a report written from the terminal. The agent
  is told to save such files in Downloads.

A file is announced only once it is complete: Deskfish waits until its size has stopped
changing and Firefox's temporary `.part` file is gone, so a large download does not show up
half-finished. Hidden files and temporary files are ignored.

## Files from earlier

If you dismissed a card, or want a file that was downloaded in a previous session, run
**Deskfish: Save a File from the Desktop…** from the command palette. It lists everything
currently in the tank's Downloads folder and saves the one you pick.

## Details and limits

- Transfers go through the tank's control API, not through a shared folder, so the same
  mechanism works unchanged for a tank running on another machine.
- The size limit in both directions is 100 MB per file.
- You cannot drag a file from your desktop onto the Desktop tab; use the paperclip.
- Files in Uploads and Downloads persist with the rest of the agent's home folder across
  restarts. Clean them up from a terminal in the tank if they pile up, or reset the tank as
  described in [The tank](the-tank).
- An optional shared folder for large files is on the roadmap. It will be off by default.
