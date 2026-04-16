/**
 * GitHub REST API integration.
 * Runs in the React UI iframe (browser context).
 */

import type { GitHubFile } from '../../shared/messages'

export type { GitHubFile }

export interface GitHubConfig {
  pat: string
  repo: string       // 'org/repo-name'
  branch: string
  tokensPath: string // e.g. 'tokens/'
}

export interface PRResult {
  url: string
  number: number
  title: string
}

// Minimal GitHub API response shapes
interface TreeResponse   { tree: Array<{ type: string; path: string }> }
interface ContentsResponse { content: string; sha: string }
interface RefResponse    { object: { sha: string } }
interface PRResponse     { html_url: string; number: number; title: string }
type BranchListResponse = Array<{ name: string }>

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export async function fetchBranches(pat: string, repo: string): Promise<string[]> {
  // Fetches up to 100 branches — enough for all realistic repos
  const data = await apiGet<BranchListResponse>(
    `repos/${repo}/branches?per_page=100`,
    pat,
  )
  return data.map((b) => b.name)
}

export async function fetchTokenFiles(config: GitHubConfig): Promise<GitHubFile[]> {
  const tree = await apiGet<TreeResponse>(
    `repos/${config.repo}/git/trees/${encodeURIComponent(config.branch)}?recursive=1`,
    config.pat,
  )

  const jsonPaths = tree.tree
    .filter((item) =>
      item.type === 'blob' &&
      item.path.startsWith(config.tokensPath) &&
      item.path.endsWith('.json'),
    )
    .map((item) => item.path)

  return Promise.all(jsonPaths.map((path) => fetchFile(path, config)))
}

async function fetchFile(path: string, config: GitHubConfig): Promise<GitHubFile> {
  const data = await apiGet<ContentsResponse>(
    `repos/${config.repo}/contents/${path}?ref=${encodeURIComponent(config.branch)}`,
    config.pat,
  )
  const content = atob(data.content.replace(/\n/g, ''))
  return { path, content, sha: data.sha }
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
  )
  const baseSha = baseRef.object.sha

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const newBranch = `tokens/sync-${timestamp}`

  await apiPost(`repos/${config.repo}/git/refs`, config.pat, {
    ref: `refs/heads/${newBranch}`,
    sha: baseSha,
  })

  for (const file of files) {
    const encoded = btoa(unescape(encodeURIComponent(file.content)))

    let existingSha: string | undefined
    try {
      const existing = await apiGet<ContentsResponse>(
        `repos/${config.repo}/contents/${file.path}?ref=${newBranch}`,
        config.pat,
      )
      existingSha = existing.sha
    } catch {
      // file doesn't exist yet — fine
    }

    await apiPut(`repos/${config.repo}/contents/${file.path}`, config.pat, {
      message: `chore: update ${file.path}`,
      content: encoded,
      branch: newBranch,
      ...(existingSha ? { sha: existingSha } : {}),
    })
  }

  const pr = await apiPost<PRResponse>(`repos/${config.repo}/pulls`, config.pat, {
    title: message,
    head: newBranch,
    base: config.branch,
    body: [
      '## Token sync',
      '',
      `Updated ${files.length} token file(s) via Token Sync plugin.`,
      '',
      '> Merge to apply changes to the design system token repository.',
    ].join('\n'),
  })

  return { url: pr.html_url, number: pr.number, title: pr.title }
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

const BASE = 'https://api.github.com'

async function apiGet<T>(path: string, pat: string): Promise<T> {
  const res = await fetch(`${BASE}/${path}`, { headers: headers(pat) })
  if (!res.ok) throw new Error(`GitHub ${res.status}: GET /${path}`)
  return res.json() as Promise<T>
}

async function apiPost<T = unknown>(path: string, pat: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}/${path}`, {
    method: 'POST',
    headers: headers(pat),
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`GitHub ${res.status}: POST /${path}`)
  return res.json() as Promise<T>
}

async function apiPut<T = unknown>(path: string, pat: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}/${path}`, {
    method: 'PUT',
    headers: headers(pat),
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`GitHub ${res.status}: PUT /${path}`)
  return res.json() as Promise<T>
}

function headers(pat: string): Record<string, string> {
  return {
    Authorization: `Bearer ${pat}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
  }
}
