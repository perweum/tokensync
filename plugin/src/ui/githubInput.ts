/**
 * Cleaning up what a person pastes into the Repository and Token fields.
 *
 * Both fail the same unhelpful way when they're slightly off: the browser
 * refuses to send the request at all (`TypeError: Failed to fetch`), so there's
 * no HTTP status for the plugin to explain, and it used to say "check your
 * internet connection". Verified against a real browser: a repo pasted as
 * `https://github.com/org/name`, `org/name/`, or `org/name/tree/main` fails
 * that way, as does a token with a line break or zero-width space inside it —
 * `String.trim()` removes neither from the middle.
 */

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
const NAME = /^[A-Za-z0-9._-]+$/;

/**
 * Reduces a pasted repository reference to `owner/name`, or null if it can't
 * be one. Accepts what people actually copy from GitHub: a browser URL (with a
 * trailing slash, a `/tree/main/...` or `/pulls?...` tail), a `.git` suffix,
 * `github.com/...` without a scheme, or an SSH remote (`git@github.com:o/n.git`).
 */
export function normalizeRepo(raw: string): string | null {
  let s = raw.trim();
  if (!s) return null;

  // The only host this plugin may talk to is api.github.com, so a URL for any
  // other host can't be a repo reference — reject rather than strip it.
  const ssh = s.match(/^git@github\.com:(.+)$/i);
  if (ssh) {
    s = ssh[1];
  } else {
    const url = s.match(/^(?:https?:\/\/)?(?:www\.)?([^/]+\.[^/]+?)\/(.+)$/i);
    if (url && /\./.test(url[1])) {
      if (url[1].toLowerCase() !== "github.com") return null;
      s = url[2];
    }
  }

  // Drop any query/fragment, then keep only the first two path segments.
  s = s.split(/[?#]/)[0];
  const parts = s.split("/");
  // "owner//name" has an empty middle segment — not something to guess about.
  if (parts.length > 2 && parts.slice(0, 2).some((p) => p === "")) return null;
  const owner = parts[0];
  let name = parts[1];
  if (!owner || !name) return null;
  name = name.replace(/\.git$/i, "");

  return OWNER.test(owner) && NAME.test(name) ? `${owner}/${name}` : null;
}

/**
 * Removes whitespace and invisible characters from a pasted token. A GitHub
 * token never contains any, but copying one out of a chat, a password manager
 * or a document regularly brings a line break or a zero-width space along.
 * Deliberately does NOT touch other characters: a stray `…` or smart quote is
 * a real mistake the user has to fix, and silently deleting it would turn a
 * wrong token into a different wrong token.
 */
export function cleanToken(raw: string): string {
  return raw.replace(/[\s​-‍⁠﻿]/g, "");
}
