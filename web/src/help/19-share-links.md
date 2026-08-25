---
title: Share links
section: Studies
---

Publishes a **read-only snapshot** of the project to a web address you can send to a client. They open it in a browser with no account, no sign-in and nothing to install. Open it from **Results → Share a read-only link**.

The link is a **capability**: anyone holding it can open it. There is no password on top, and no list of who is allowed. Treat the address the way you would treat the document itself — forwarding the link is giving someone the contents.

## What the client sees

- Contours, at the levels you had on screen when you published.
- Receivers, with their limits, their level in each published state, and pass/fail.
- Source positions, with the model and mode each one was running.
- Noise walls, custom contour lines and annotations.
- A header with the project name, your label, the publish date, and a **DRAFT** badge unless you marked it final.

## What is never in a share

Not "hidden in the viewer" — **not in the published data at all**, so there is nothing to find by looking at the page source:

- Email addresses, user accounts, and who the project is shared with internally.
- Per-source contributions — what each turbine or battery adds at each receiver.
- Terrain data.
- Anything from the catalog beyond the model and mode names.

The published data is assembled server-side by copying a named list of fields, rather than by removing the sensitive ones from a project. That distinction is the reason the list above can be relied on: a field added to BESSTY next year is absent from shares by default, instead of being included until someone remembers to exclude it.

## Choosing what to publish

The viewer does no calculation — it can only show states that were **solved before publishing**. The dialog lists what this session has computed:

- the period and wind speed currently on screen;
- every period and wind speed a **wind sweep** solved.

Tick the ones the client should be able to switch between. If you want all three periods, run a wind sweep with all three ticked — that solves them properly rather than having the share dialog guess.

**Size matters here**, and the dialog prices each state. The filled colour grid is the expensive part; contour lines are a fraction of the size and stay sharp at any zoom. A share has to fit inside a single database document, so a ten-wind-speed share with filled grids will be refused — untick the filled grid, or publish fewer states. Publishing checks the real size and refuses rather than quietly dropping anything.

## Expiry and withdrawing

Every link expires. The default is **90 days**; 7, 30, 180 and 365 are also offered, and there is no "never" — a public address that works forever is a credential nobody remembers issuing.

**Withdraw** kills a link immediately. It cannot be undone: publishing again creates a new link at a new address. Withdrawing does not un-send anything already read, so it limits future access rather than undoing past access.

Expiry and withdrawal are enforced by the database, not by the viewer. An expired or withdrawn link stops returning data at all.

## Updating a share

A share is **frozen**. Editing the project afterwards changes nothing for anyone holding the link — which is the point: a number you sent to a council does not silently change under them.

To send updated results, publish again and send the new link. Withdraw the old one if it should no longer be readable.

## Before you send one

- Check the **DRAFT / Final** marking. It shows in the viewer's header and is the fastest way to stop a working draft being read as an issued result.
- Check which states you ticked. The client can switch between exactly those and no others.
- Remember the address is the access. Sending it to the wrong person is the same as sending them the file.
