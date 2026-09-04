/**
 * GitHub REST API integration.
 * Runs in the React UI iframe (browser context).
 */

import type { GitHubFile } from "../../shared/messages";

export type { GitHubFile };

export interface GitHubConfig {
  pat: string;
  repo: string; // 'org/repo-name'
  branch: string;
  tokensPath: string; // e.g. 'tokens/'
}

export interface PRResult {
  url: string;
  number: number;
  title: string;
}

/** A failed GitHub REST call. Carries the raw status/method/path so callers
 * can map it to plain-language copy (see `../errors.ts`) without re-parsing
 * a formatted string. */
export class GitHubApiError extends Error {
  readonly status: number;
  readonly method: string;
  readonly path: string;

  constructor(status: number, method: string, path: string) {
    super(`GitHub ${status}: ${method} /${path}`);
    this.name = "GitHubApiError";
    this.status = status;
    this.method = method;
    this.path = path;
  }
}

// Minimal GitHub API response shapes
interface TreeResponse {
  tree: Array<{ type: string; path: string }>;
}
interface ContentsResponse {
  content: string;
  sha: string;
}
interface RefResponse {
  object: { sha: string };
}
interface PRResponse {
  html_url: string;
  number: number;
  title: string;
}
type BranchListResponse = Array<{ name: string }>;

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export async function fetchBranches(pat: string, repo: string): Promise<string[]> {
  // Fetches up to 100 branches — enough for all realistic repos
  const data = await apiGet<BranchListResponse>(`repos/${repo}/branches?per_page=100`, pat);
  return data.map((b) => b.name);
}

/**
 * Create a new branch from an existing branch's HEAD SHA.
 * Returns the new branch name.
 */
export async function createBranch(
  pat: string,
  repo: string,
  newBranchName: string,
  fromBranch: string,
): Promise<string> {
  const ref = await apiGet<RefResponse>(`repos/${repo}/git/ref/heads/${fromBranch}`, pat);
  await apiPost(`repos/${repo}/git/refs`, pat, {
    ref: `refs/heads/${newBranchName}`,
    sha: ref.object.sha,
  });
  return newBranchName;
}

export async function fetchTokenFiles(config: GitHubConfig): Promise<GitHubFile[]> {
  const tree = await apiGet<TreeResponse>(
    `repos/${config.repo}/git/trees/${encodeURIComponent(config.branch)}?recursive=1`,
    config.pat,
  );

  const jsonPaths = tree.tree
    .filter(
      (item) =>
        item.type === "blob" &&
        item.path.startsWith(config.tokensPath) &&
        item.path.endsWith(".json"),
    )
    .map((item) => item.path);

  return Promise.all(jsonPaths.map((path) => fetchFile(path, config)));
}

async function fetchFile(path: string, config: GitHubConfig): Promise<GitHubFile> {
  const data = await apiGet<ContentsResponse>(
    `repos/${config.repo}/contents/${path}?ref=${encodeURIComponent(config.branch)}`,
    config.pat,
  );
  const content = decodeBase64Utf8(data.content.replace(/\n/g, ""));
  return { path, content, sha: data.sha };
}

// ---------------------------------------------------------------------------
// Write (create PR)
// ---------------------------------------------------------------------------

export async function createTokenPR(
  config: GitHubConfig,
  files: Array<{ path: string; content: string }>,
  message: string,
): Promise<PRResult> {
  const baseRef = await apiGet<RefResponse>(
    `repos/${config.repo}/git/ref/heads/${config.branch}`,
    config.pat,
  );
  const baseSha = baseRef.object.sha;

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const newBranch = `tokens/sync-${timestamp}`;

  await apiPost(`repos/${config.repo}/git/refs`, config.pat, {
    ref: `refs/heads/${newBranch}`,
    sha: baseSha,
  });

  for (const file of files) {
    const encoded = encodeUtf8Base64(file.content);

    let existingSha: string | undefined;
    try {
      const existing = await apiGet<ContentsResponse>(
        `repos/${config.repo}/contents/${file.path}?ref=${newBranch}`,
        config.pat,
      );
      existingSha = existing.sha;
    } catch (err) {
      // 404 means the file doesn't exist yet — fine, we're creating it.
      // Anything else (auth, rate limit, network) should surface, not be
      // silently treated as "new file" and fail confusingly on the PUT below.
      if (!(err instanceof GitHubApiError) || err.status !== 404) throw err;
    }

    await apiPut(`repos/${config.repo}/contents/${file.path}`, config.pat, {
      message: `chore: update ${file.path}`,
      content: encoded,
      branch: newBranch,
      ...(existingSha ? { sha: existingSha } : {}),
    });
  }

  const pr = await apiPost<PRResponse>(`repos/${config.repo}/pulls`, config.pat, {
    title: message,
    head: newBranch,
    base: config.branch,
    body: [
      "## Token sync",
      "",
      `Updated ${files.length} token file(s) via Token Sync plugin.`,
      "",
      "> Merge to apply changes to the design system token repository.",
    ].join("\n"),
  });

  return { url: pr.html_url, number: pr.number, title: pr.title };
}

// ---------------------------------------------------------------------------
// Base64 ↔ UTF-8
// ---------------------------------------------------------------------------

/**
 * GitHub's Contents API base64-encodes the file's raw UTF-8 bytes. Plain
 * `atob` decodes base64 into a "binary string" — one JS character per byte,
 * not one character per Unicode code point — so any multi-byte UTF-8
 * character (an em dash, say) comes out as several mojibake characters
 * instead of the original one. Re-interpreting each decoded byte through
 * `TextDecoder` reassembles the original UTF-8 sequence correctly.
 */
export function decodeBase64Utf8(base64: string): string {
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder("utf-8").decode(bytes);
}

/** Inverse of decodeBase64Utf8: encode a JS string to UTF-8 bytes first, then
 * base64 — `btoa` alone throws (or mangles) on any character outside Latin-1. */
export function encodeUtf8Base64(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

const BASE = "https://api.github.com";

async function apiGet<T>(path: string, pat: string): Promise<T> {
  const res = await fetch(`${BASE}/${path}`, { headers: headers(pat) });
  if (!res.ok) throw new GitHubApiError(res.status, "GET", path);
  return res.json() as Promise<T>;
}

async function apiPost<T = unknown>(path: string, pat: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}/${path}`, {
    method: "POST",
    headers: headers(pat),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new GitHubApiError(res.status, "POST", path);
  return res.json() as Promise<T>;
}

async function apiPut<T = unknown>(path: string, pat: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}/${path}`, {
    method: "PUT",
    headers: headers(pat),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new GitHubApiError(res.status, "PUT", path);
  return res.json() as Promise<T>;
}

function headers(pat: string): Record<string, string> {
  return {
    Authorization: `Bearer ${pat}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  };
}
