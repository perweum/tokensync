/**
 * GitHub REST API integration.
 * All calls go through the Figma plugin network proxy (allowed domain: api.github.com).
 */

export interface GitHubConfig {
  pat: string
  repo: string    // 'org/repo-name'
  branch: string
  tokensPath: string // e.g. 'tokens/'
}

export interface GitHubFile {
  path: string
  content: string   // decoded UTF-8 content
  sha: string       // needed for updates
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Fetches all token JSON files from the configured path in the repo.
 */
export async function fetchTokenFiles(config: GitHubConfig): Promise<GitHubFile[]> {
  const tree = await apiGet(
    `repos/${config.repo}/git/trees/HEAD?recursive=1`,
    config.pat,
  )

  const jsonFiles: string[] = tree.tree
    .filter((item: { type: string; path: string }) =>
      item.type === 'blob' &&
      item.path.startsWith(config.tokensPath) &&
      item.path.endsWith('.json'),
    )
    .map((item: { path: string }) => item.path)

  const files = await Promise.all(
    jsonFiles.map((path) => fetchFile(path, config)),
  )

  return files
}

async function fetchFile(path: string, config: GitHubConfig): Promise<GitHubFile> {
  const data = await apiGet(`repos/${config.repo}/contents/${path}`, config.pat)
  const content = atob(data.content.replace(/\n/g, ''))
  return { path, content, sha: data.sha }
}

// ---------------------------------------------------------------------------
// Write (create PR)
// ---------------------------------------------------------------------------

export interface PRResult {
  url: string
  number: number
  title: string
}

/**
 * Commits changed token files to a new branch and opens a Pull Request.
 */
export async function createTokenPR(
  config: GitHubConfig,
  files: Array<{ path: string; content: string }>,
  message: string,
): Promise<PRResult> {
  // 1. Get base branch SHA
  const baseRef = await apiGet(
    `repos/${config.repo}/git/ref/heads/${config.branch}`,
    config.pat,
  )
  const baseSha: string = baseRef.object.sha

  // 2. Create a new branch
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const newBranch = `tokens/sync-${timestamp}`

  await apiPost(`repos/${config.repo}/git/refs`, config.pat, {
    ref: `refs/heads/${newBranch}`,
    sha: baseSha,
  })

  // 3. Commit each file
  for (const file of files) {
    const encoded = btoa(unescape(encodeURIComponent(file.content)))

    // Check if file exists (for sha)
    let existingSha: string | undefined
    try {
      const existing = await apiGet(
        `repos/${config.repo}/contents/${file.path}?ref=${newBranch}`,
        config.pat,
      )
      existingSha = existing.sha
    } catch {
      // file doesn't exist yet — that's fine
    }

    await apiPut(`repos/${config.repo}/contents/${file.path}`, config.pat, {
      message: `chore: update ${file.path}`,
      content: encoded,
      branch: newBranch,
      ...(existingSha ? { sha: existingSha } : {}),
    })
  }

  // 4. Open PR
  const pr = await apiPost(`repos/${config.repo}/pulls`, config.pat, {
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

async function apiGet(path: string, pat: string): Promise<unknown> {
  const res = await fetch(`${BASE}/${path}`, {
    headers: headers(pat),
  })
  if (!res.ok) throw new Error(`GitHub API error ${res.status}: GET /${path}`)
  return res.json()
}

async function apiPost(path: string, pat: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${BASE}/${path}`, {
    method: 'POST',
    headers: headers(pat),
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`GitHub API error ${res.status}: POST /${path}`)
  return res.json()
}

async function apiPut(path: string, pat: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${BASE}/${path}`, {
    method: 'PUT',
    headers: headers(pat),
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`GitHub API error ${res.status}: PUT /${path}`)
  return res.json()
}

function headers(pat: string): Record<string, string> {
  return {
    Authorization: `Bearer ${pat}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
  }
}
