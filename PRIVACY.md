# Token Spark — Privacy Policy

_Last updated: 2026-09-08_

Token Spark is a Figma plugin that syncs design tokens between Figma Variables
and a GitHub repository. This document describes, precisely, what data the
plugin handles, where it goes, and what it does not do.

## What the plugin stores

Each project you connect is stored using Figma's own `clientStorage` API,
scoped to your Figma account on the machine/browser you're using — not on any
server operated by this plugin's developers, because none exists. Stored
fields per project:

- Project name (a label you choose)
- GitHub Personal Access Token (PAT)
- GitHub repository, branch, and the path to the token files within it
- Figma file key (optional, informational)
- A per-project last-sync timestamp and a couple of UI preferences (active
  branch selection, whether to sync Text Styles)

Removing a project from the plugin removes all of this from `clientStorage`.

## What the plugin sends, and to whom

The only external network destination is `api.github.com` — declared
explicitly in the plugin's manifest (`networkAccess.allowedDomains`), which
Figma enforces at the platform level; the plugin cannot reach any other host.

Your GitHub PAT is sent to `api.github.com` as a bearer authorization header,
exactly the way any Git tooling authenticates to GitHub's API. It is never
sent anywhere else — not to a Token Spark server, not to Figma, not to any
analytics or logging service.

Beyond that, the plugin reads and writes:

- **In your GitHub repository**: the token JSON files at the path you
  configure, `metadata.json`, and any files Token Spark's own transformers are
  configured to generate (CSS/JS/TS/Dart/Swift — see the plugin's Output
  Formats screen; entirely optional and off by default).
- **In the current Figma file**: Variables, Variable Collections, and (if
  enabled) Text Styles.

## What the plugin does not do

- No analytics, telemetry, or usage tracking of any kind.
- No data is sent to a server operated by this plugin's developers — there
  isn't one. The plugin talks only to Figma's own APIs (local to the file
  you're in) and to GitHub's REST API, using credentials you provide.
- No data is shared with, or sold to, any third party.
- No advertising.

## Your GitHub token

We recommend creating a **fine-grained personal access token** scoped to only
the repository you're syncing, rather than a broad classic token — see
`docs/github-token-setup.md` for exact steps. The token is only as powerful
as the permissions you grant it when creating it; Token Spark never requests
broader access than the GitHub API calls it makes actually require (reading
and writing repository contents, and opening Pull Requests).

## Changes to this policy

If what the plugin does changes in a way that affects this document, this
file will be updated and the date at the top will change.

## Contact

Questions about this policy or how the plugin handles data: **[add a support
contact email/URL here before publishing]**.
