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

/** GitHub answered, but not with everything — a silently partial read is worse
 * than a failed one, because a token file that goes missing from the read
 * looks exactly like "this token was deleted in GitHub", and a pull's Apply
 * then deletes the matching Figma variable. */
export class GitHubReadIncompleteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubReadIncompleteError";
  }
}

// Minimal GitHub API response shapes
interface TreeResponse {
  /** Set when the repo is too big for one recursive listing — the `tree`
   * array is then an arbitrary subset, not the whole repo. */
  truncated?: boolean;
  tree: Array<{ type: string; path: string }>;
}
interface ContentsResponse {
  content: string;
  /** "base64" for ordinary files; "none" (with an empty `content`) over 1 MB. */
  encoding?: string;
  sha: string;
}
interface BlobReadResponse {
  content: string;
  encoding?: string;
}
interface RefResponse {
  object: { sha: string };
}
interface CommitResponse {
  sha: string;
  tree: { sha: string };
}
interface BlobResponse {
  sha: string;
}
interface TreeCreateResponse {
  sha: string;
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

/** The repo's full recursive tree at `config.branch`, or a thrown
 * GitHubReadIncompleteError if GitHub could only list part of it. */
async function fetchTree(config: GitHubConfig): Promise<TreeResponse["tree"]> {
  const tree = await apiGet<TreeResponse>(
    `repos/${config.repo}/git/trees/${encodeURIComponent(config.branch)}?recursive=1`,
    config.pat,
  );
  if (tree.truncated) {
    throw new GitHubReadIncompleteError(
      "This repository is too large for GitHub to list in one response, so Token Spark can't be sure it's seeing every token file. It stopped rather than risk deleting variables that do exist in GitHub.",
    );
  }
  return tree.tree;
}

export async function fetchTokenFiles(config: GitHubConfig): Promise<GitHubFile[]> {
  const tree = await fetchTree(config);

  const jsonPaths = tree
    .filter(
      (item) =>
        item.type === "blob" &&
        item.path.startsWith(config.tokensPath) &&
        item.path.endsWith(".json"),
    )
    .map((item) => item.path);

  return Promise.all(jsonPaths.map((path) => fetchFile(path, config)));
}

/**
 * Every real blob path currently in the repo at `config.branch` — not just
 * the token JSON `fetchTokenFiles` reads. Used to tell whether a configured
 * platform output file (`dist/tokens.css`, etc. — outside `tokensPath`,
 * never fetched otherwise) already exists, so a push with zero token
 * changes can still recognize "an output format was just enabled and its
 * file has never been generated" instead of reporting nothing to do.
 */
export async function fetchRepoPaths(config: GitHubConfig): Promise<Set<string>> {
  const tree = await fetchTree(config);
  return new Set(tree.filter((item) => item.type === "blob").map((item) => item.path));
}

async function fetchFile(path: string, config: GitHubConfig): Promise<GitHubFile> {
  // Encode each segment — a `#`, `?` or `%` in a file name would otherwise be
  // read as URL syntax and fail the whole pull.
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  const data = await apiGet<ContentsResponse>(
    `repos/${config.repo}/contents/${encodedPath}?ref=${encodeURIComponent(config.branch)}`,
    config.pat,
  );
  let base64: string | null = data.encoding === "base64" ? data.content : null;
  if (base64 === null) {
    // Over 1 MB the Contents API returns encoding "none" and an empty
    // `content`, which used to decode to "" and parse as "no such file".
    // The blob endpoint has the real bytes.
    const blob = await apiGet<BlobReadResponse>(
      `repos/${config.repo}/git/blobs/${data.sha}`,
      config.pat,
    );
    if (blob.encoding !== "base64") {
      throw new GitHubReadIncompleteError(
        `Couldn't read ${path} from GitHub — its content came back empty. It stopped rather than treat the file as missing.`,
      );
    }
    base64 = blob.content;
  }
  const content = decodeBase64Utf8(base64.replace(/\n/g, ""));
  return { path, content, sha: data.sha };
}

// ---------------------------------------------------------------------------
// Write (create PR)
// ---------------------------------------------------------------------------

/**
 * Writes `files` as a single commit via the Git Data API (blobs → one tree →
 * one commit → one branch ref) rather than one Contents-API PUT per file.
 * Two reasons: it's one clean commit instead of N noisy ones, and it's
 * actually safe to parallelize — a blob is a pure content-addressed object
 * with no branch/ref state, unlike a sequence of per-file Contents-API
 * commits, where doing the same in parallel would race each PUT's base sha
 * against the branch head every other PUT is also moving (a 409 conflict
 * risk), and running them sequentially (the previous approach) made
 * PR-creation latency scale linearly with file count.
 */
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
  const baseCommit = await apiGet<CommitResponse>(
    `repos/${config.repo}/git/commits/${baseSha}`,
    config.pat,
  );

  const blobs = await Promise.all(
    files.map((file) =>
      apiPost<BlobResponse>(`repos/${config.repo}/git/blobs`, config.pat, {
        content: encodeUtf8Base64(file.content),
        encoding: "base64",
      }),
    ),
  );

  // base_tree carries over every file this PR doesn't touch — only the
  // changed paths need listing here.
  const tree = await apiPost<TreeCreateResponse>(`repos/${config.repo}/git/trees`, config.pat, {
    base_tree: baseCommit.tree.sha,
    tree: files.map((file, i) => ({
      path: file.path,
      mode: "100644",
      type: "blob",
      sha: blobs[i].sha,
    })),
  });

  const commit = await apiPost<CommitResponse>(`repos/${config.repo}/git/commits`, config.pat, {
    message,
    tree: tree.sha,
    parents: [baseSha],
  });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const newBranch = `tokens/sync-${timestamp}`;

  await apiPost(`repos/${config.repo}/git/refs`, config.pat, {
    ref: `refs/heads/${newBranch}`,
    sha: commit.sha,
  });

  const pr = await apiPost<PRResponse>(`repos/${config.repo}/pulls`, config.pat, {
    title: message,
    head: newBranch,
    base: config.branch,
    body: [
      "## Token spark",
      "",
      `Updated ${files.length} token file(s) via Token Spark plugin.`,
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

function headers(pat: string): Record<string, string> {
  return {
    Authorization: `Bearer ${pat}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  };
}
