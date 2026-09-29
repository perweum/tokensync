import { describe, it, expect, vi, afterEach } from "vitest";
import {
  decodeBase64Utf8,
  encodeUtf8Base64,
  createTokenPR,
  fetchTokenFiles,
  fetchRepoPaths,
} from "./useGitHub";

describe("base64 <-> UTF-8 round trip", () => {
  // Reproduces a real corruption found in production: metadata.json's
  // hand-written $description fields use an em dash ("—", U+2014). Plain
  // atob/btoa treat base64 as raw Latin-1 bytes, not UTF-8, so a multi-byte
  // character survives neither a read (mojibake in the app) nor a write
  // (mojibake committed to GitHub) — confirmed via a real PR whose diff
  // showed "doesn't match anything — Coop" turn into "doesn't match anything
  // â Coop" after a round trip through the old atob/btoa-only code.
  it("decodes a real GitHub base64 payload containing an em dash correctly", () => {
    const original = "doesn't match anything — Coop doesn't appear to have one";
    // What GitHub's Contents API actually returns: base64 of the raw UTF-8 bytes.
    const utf8Bytes = new TextEncoder().encode(original);
    const githubBase64 = btoa(String.fromCharCode(...utf8Bytes));

    expect(decodeBase64Utf8(githubBase64)).toBe(original);
  });

  it("encodes a string with non-ASCII characters to the same base64 GitHub would produce", () => {
    const content = "café — 日本語 — emoji 🎉";
    const encoded = encodeUtf8Base64(content);

    // Decode independently via the UTF-8-correct path to confirm round trip.
    expect(decodeBase64Utf8(encoded)).toBe(content);

    // And confirm it matches raw UTF-8 bytes base64'd directly — i.e. exactly
    // what a correct GitHub PUT payload looks like.
    const expectedBytes = new TextEncoder().encode(content);
    const expectedBase64 = btoa(String.fromCharCode(...expectedBytes));
    expect(encoded).toBe(expectedBase64);
  });

  it("round-trips plain ASCII exactly as before (no regression for the common case)", () => {
    const content = JSON.stringify({ a: 1, b: "hello" }, null, 2);
    expect(decodeBase64Utf8(encodeUtf8Base64(content))).toBe(content);
  });
});

describe("createTokenPR — writes one commit via the Git Data API, not N sequential ones", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates one blob per file, one tree, one commit, and one branch ref pointing at that commit", async () => {
    const calls: Array<{ path: string; method: string; body: unknown }> = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const path = url.replace("https://api.github.com/", "");
        const method = init?.method ?? "GET";
        const body = init?.body ? JSON.parse(init.body as string) : undefined;
        calls.push({ path, method, body });

        const json = (data: unknown) => ({ ok: true, status: 200, json: async () => data });

        if (path === "repos/org/repo/git/ref/heads/main") {
          return json({ object: { sha: "base-sha" } });
        }
        if (path === "repos/org/repo/git/commits/base-sha") {
          return json({ sha: "base-sha", tree: { sha: "base-tree-sha" } });
        }
        if (path === "repos/org/repo/git/blobs") {
          // Each blob's own content identifies it in later assertions.
          return json({ sha: `blob-sha:${(body as { content: string }).content}` });
        }
        if (path === "repos/org/repo/git/trees") {
          return json({ sha: "new-tree-sha" });
        }
        if (path === "repos/org/repo/git/commits") {
          return json({ sha: "new-commit-sha", tree: { sha: "new-tree-sha" } });
        }
        if (path === "repos/org/repo/git/refs") {
          return json({});
        }
        if (path === "repos/org/repo/pulls") {
          return json({ html_url: "https://github.com/org/repo/pull/1", number: 1, title: "t" });
        }
        throw new Error(`Unexpected request: ${method} ${path}`);
      }),
    );

    const files = [
      { path: "tokens/metadata.json", content: "{}" },
      { path: "tokens/primitives/color.json", content: "{}" },
    ];

    await createTokenPR(
      { pat: "x", repo: "org/repo", branch: "main", tokensPath: "tokens/" },
      files,
      "chore: sync",
    );

    const blobCalls = calls.filter((c) => c.path === "repos/org/repo/git/blobs");
    const treeCalls = calls.filter((c) => c.path === "repos/org/repo/git/trees");
    const commitCalls = calls.filter(
      (c) => c.path === "repos/org/repo/git/commits" && c.method === "POST",
    );
    const refCalls = calls.filter((c) => c.path === "repos/org/repo/git/refs");

    // One blob per file — not one commit per file.
    expect(blobCalls).toHaveLength(2);
    // Exactly one tree and one commit for the whole batch, not two.
    expect(treeCalls).toHaveLength(1);
    expect(commitCalls).toHaveLength(1);
    // Exactly one branch ref created — not one PUT per file against a moving branch head.
    expect(refCalls).toHaveLength(1);

    const encodedMetadata = encodeUtf8Base64("{}");
    const treeBody = treeCalls[0].body as {
      base_tree: string;
      tree: Array<{ path: string; sha: string }>;
    };
    expect(treeBody.base_tree).toBe("base-tree-sha");
    expect(treeBody.tree).toEqual([
      {
        path: "tokens/metadata.json",
        mode: "100644",
        type: "blob",
        sha: `blob-sha:${encodedMetadata}`,
      },
      {
        path: "tokens/primitives/color.json",
        mode: "100644",
        type: "blob",
        sha: `blob-sha:${encodedMetadata}`,
      },
    ]);

    const commitBody = commitCalls[0].body as { tree: string; parents: string[] };
    expect(commitBody.tree).toBe("new-tree-sha");
    expect(commitBody.parents).toEqual(["base-sha"]);

    // The branch is created pointing straight at the new commit — no
    // separate "create empty branch then PUT each file" dance.
    const refBody = refCalls[0].body as { sha: string; ref: string };
    expect(refBody.sha).toBe("new-commit-sha");
    expect(refBody.ref).toMatch(/^refs\/heads\/tokens\/sync-/);
  });
});

describe("fetchTokenFiles — never hands back a silently incomplete or empty read", () => {
  // A missing or empty token file looks exactly like "this token was deleted
  // in GitHub" to the pull diff, and Apply then deletes the Figma variable.
  // So an incomplete read must throw, not degrade.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const config = { pat: "x", repo: "org/repo", branch: "main", tokensPath: "tokens/" };
  const json = (data: unknown) => ({ ok: true, status: 200, json: async () => data });
  const b64 = (text: string) => btoa(text);

  it("throws when GitHub reports the recursive tree was truncated", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ truncated: true, tree: [{ type: "blob", path: "tokens/a.json" }] })),
    );
    await expect(fetchTokenFiles(config)).rejects.toThrow(/too large|truncated/i);
    await expect(fetchRepoPaths(config)).rejects.toThrow(/too large|truncated/i);
  });

  it("reads a file over 1 MB through the blob API instead of accepting the Contents API's empty body", async () => {
    // For files over 1 MB the Contents API answers with `encoding: "none"` and
    // an empty `content` string — which decoded to "" and parsed as no file.
    const paths: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const path = url.replace("https://api.github.com/", "");
        paths.push(path);
        if (path.startsWith("repos/org/repo/git/trees/")) {
          return json({ tree: [{ type: "blob", path: "tokens/big.json", sha: "sha-big" }] });
        }
        if (path.startsWith("repos/org/repo/contents/tokens/big.json")) {
          return json({ content: "", encoding: "none", size: 2_000_000, sha: "sha-big" });
        }
        if (path === "repos/org/repo/git/blobs/sha-big") {
          return json({ content: b64('{"a":1}'), encoding: "base64", sha: "sha-big" });
        }
        throw new Error(`Unexpected request: ${path}`);
      }),
    );

    const files = await fetchTokenFiles(config);
    expect(files).toHaveLength(1);
    expect(files[0].content).toBe('{"a":1}');
    expect(paths).toContain("repos/org/repo/git/blobs/sha-big");
  });

  it("throws if the file still comes back empty/unencoded after the blob fallback", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const path = url.replace("https://api.github.com/", "");
        if (path.startsWith("repos/org/repo/git/trees/")) {
          return json({ tree: [{ type: "blob", path: "tokens/big.json", sha: "sha-big" }] });
        }
        if (path.startsWith("repos/org/repo/contents/")) {
          return json({ content: "", encoding: "none", size: 2_000_000, sha: "sha-big" });
        }
        return json({ content: "", encoding: "none", sha: "sha-big" });
      }),
    );
    await expect(fetchTokenFiles(config)).rejects.toThrow(/tokens\/big\.json/);
  });

  it("encodes each path segment so a #, ? or % in a file name doesn't break the request", async () => {
    const requested: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const path = url.replace("https://api.github.com/", "");
        if (path.startsWith("repos/org/repo/git/trees/")) {
          return json({ tree: [{ type: "blob", path: "tokens/my dir/a#b?.json", sha: "s" }] });
        }
        requested.push(path);
        return json({ content: b64("{}"), encoding: "base64", sha: "s" });
      }),
    );
    await fetchTokenFiles(config);
    expect(requested[0]).toBe("repos/org/repo/contents/tokens/my%20dir/a%23b%3F.json?ref=main");
  });

  it("still reads an ordinary base64 file exactly as before", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const path = url.replace("https://api.github.com/", "");
        if (path.startsWith("repos/org/repo/git/trees/")) {
          return json({ tree: [{ type: "blob", path: "tokens/a.json", sha: "sha-a" }] });
        }
        return json({ content: b64('{"x":2}'), encoding: "base64", size: 7, sha: "sha-a" });
      }),
    );
    const files = await fetchTokenFiles(config);
    expect(files).toEqual([{ path: "tokens/a.json", content: '{"x":2}', sha: "sha-a" }]);
  });
});
