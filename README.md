# Fresh Tech website

Marketing website for Fresh Tech, managed IT support for businesses in Shropshire,
Herefordshire, Worcestershire and Powys.

**Live site:** https://fresh-tech.uk

The site is a static [Astro](https://astro.build/) build served by Apache with small PHP
handlers on 20i. Every page is plain HTML generated from the content files in `data/` and
`content/`; there is no client-side framework.

## Layout

| Path | What it holds |
| --- | --- |
| `prototypes/html-first-slice/` | The Astro site: pages, components, styles, build and output checks, PHP handlers |
| `data/`, `content/` | Site content: services, blog, locations, case studies, pricing, navigation, legal documents |
| `hosting/routing.json` | Legacy redirects and security headers, compiled into the Apache `.htaccess` |
| `scripts/` | Sitemap and RSS generators, quality gate, release packaging and deploy, search-engine tools |
| `public/` | Root files shipped with every release: `robots.txt`, the IndexNow key, font licences |
| `brand/fonts/` | Self-hosted font files |
| `docs/` | Public build contracts |

## Quick start

Node 24 and PHP are needed.

```bash
npm ci
npm ci --prefix prototypes/html-first-slice
cd prototypes/html-first-slice
npm run dev
```

[DEVELOPMENT.md](DEVELOPMENT.md) lists the checks, the full quality gate and how a release
is built. [ARCHITECTURE.md](ARCHITECTURE.md) explains how the pieces fit together.
[AGENTS.md](AGENTS.md) holds the content and working rules.

## Updating the website

Anyone on the Fresh Tech team with write access can publish a change. Nothing is uploaded
by hand, and no hosting login is needed.

1. Make the change on a branch, never on `main`. Most pages come from the content files in
   `data/` and `content/`; [AGENTS.md](AGENTS.md) has the content rules and the steps for a
   blog post. A small text fix can be made in the GitHub web editor, which offers to create
   the branch and pull request for you.
2. Open a pull request into `main`. Two checks start by themselves: "Workspace standards"
   (under a minute) and "Static site quality" (about 20 minutes, every page in a real browser).
3. When both are green, and the pull request has the approval the repository rules ask for,
   merge it. Merging is publishing: "Deploy to 20i" builds the merged commit,
   backs up the files it replaces, uploads only the files that changed since the last
   deploy, checks the live site and restores the backup if that check fails. The change is
   live a few minutes after merging.
4. Open the live page and look at it. A red "Deploy to 20i" run means the change is not live:
   read the failed step in the Actions tab, and do not upload to 20i by hand.

To undo a change, revert its pull request on GitHub and merge the revert. "Deploy to 20i"
can also be run from the Actions tab with an earlier commit on `main`. Tick "full upload"
on a manual run to send every file again and re-check every live file for hand-made
changes (for example after 20i restores the site from its own backup).

The 20i login used by the deploy belongs to GitHub's `production` environment, which only
`main` can use; nobody needs a copy. Setting it up or replacing it is an admin job:
`scripts/setup-20i-deploy-github.sh`.

## Copyright

Copyright Fresh Tech. All rights reserved. The source is published for
transparency; no licence to reuse the code, copy, images or brand is granted.
The bundled fonts carry their own SIL Open Font Licence.
