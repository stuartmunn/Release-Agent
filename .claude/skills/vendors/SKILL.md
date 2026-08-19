---
name: vendors
description: Per-vendor guidance on what matters most in each vendor's release notes. Edit freely to tune what you get told.
---

# Vendor focus

This is the user's personal cheat-sheet for what they care about in specific vendors'
releases. Apply the matching vendor's guidance when summarising or answering about it. If a
vendor isn't listed, use good general judgement (security → breaking → features).

**To tune the app, edit this file** — add or change a vendor's bullets and the digests and
answers follow suit. Longer reference notes can live in `references/<vendor>.md`.

## Google Chrome
- Lead with **security fixes / CVEs** and their severity — this is the top concern.
- Call out **deprecations and removals** (APIs, flags) and **enterprise policy** changes.
- New features matter less unless they change defaults or break existing sites.

## Node.js
- Lead with **breaking changes** and anything affecting the current **LTS** line.
- Note **security releases** clearly and whether an upgrade is advised now.
- Call out deprecations that will bite in a future major.

## Microsoft
- Lead with **security updates** — Patch Tuesday releases, CVEs, and security advisories
  across Windows, Microsoft 365, Azure, and .NET. Note severity and whether it's
  actively exploited.
- Call out anything requiring action (a patch to apply, a config to change) clearly.
- Feature/product announcements matter far less here — mention only briefly, or fold
  into "other updates" unless something's genuinely notable.

## Claude Code
- Lead with **quality-of-life improvements** — anything that makes day-to-day use
  smoother: new slash commands, editor/IDE integration, terminal UI polish, keyboard
  shortcuts, workflow shortcuts, performance/responsiveness.
- Also flag breaking changes and deprecations, but they're secondary to the QoL angle here.
- Skip routine bug fixes unless they fix something that was a genuine daily annoyance.

## (Add your own)
Copy the pattern above for any vendor you follow. Keep each to a few plain bullets: "for
this vendor, tell me X and Y first."
