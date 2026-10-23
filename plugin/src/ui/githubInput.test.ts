import { describe, it, expect } from "vitest";
import { normalizeRepo, cleanToken } from "./githubInput";

describe("normalizeRepo", () => {
  it("accepts a plain owner/name unchanged", () => {
    expect(normalizeRepo("bekk/designsystem")).toBe("bekk/designsystem");
    expect(normalizeRepo("  bekk/designsystem  ")).toBe("bekk/designsystem");
    expect(normalizeRepo("my-org/design.tokens_v2")).toBe("my-org/design.tokens_v2");
  });

  it("reduces whatever a user is likely to paste from GitHub to owner/name", () => {
    // Each of these made the browser fail with a bare "Failed to fetch" (no
    // HTTP response at all), which the plugin reported as a network outage.
    for (const pasted of [
      "https://github.com/bekk/designsystem",
      "https://github.com/bekk/designsystem/",
      "http://github.com/bekk/designsystem",
      "github.com/bekk/designsystem",
      "www.github.com/bekk/designsystem",
      "https://github.com/bekk/designsystem.git",
      "https://github.com/bekk/designsystem/tree/main/packages/design-tokens",
      "https://github.com/bekk/designsystem/pulls?q=is%3Aopen",
      "bekk/designsystem/",
      "bekk/designsystem.git",
      "git@github.com:bekk/designsystem.git",
    ]) {
      expect(normalizeRepo(pasted), pasted).toBe("bekk/designsystem");
    }
  });

  it("returns null for something that can't be an owner/name", () => {
    for (const bad of [
      "",
      "   ",
      "designsystem",
      "/designsystem",
      "bekk/",
      "a b/c",
      "bekk/design system",
      "https://example.com/x/y",
      "bekk//designsystem",
    ]) {
      expect(normalizeRepo(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe("cleanToken", () => {
  it("leaves a normal token alone", () => {
    expect(cleanToken("ghp_abcDEF0123456789abcdef0123456789abcd")).toBe(
      "ghp_abcDEF0123456789abcdef0123456789abcd",
    );
    expect(cleanToken("github_pat_11ABC_def456")).toBe("github_pat_11ABC_def456");
  });

  it("strips whitespace and invisible characters that come along when copying a token", () => {
    // A zero-width space or a line break inside the token makes the browser
    // refuse to build the Authorization header at all — and String.trim()
    // doesn't remove either of them from the middle (or a zero-width space
    // from the ends).
    expect(cleanToken("  ghp_abc\n")).toBe("ghp_abc");
    expect(cleanToken("ghp_abc\ndef")).toBe("ghp_abcdef");
    expect(cleanToken("ghp_abc​def")).toBe("ghp_abcdef");
    expect(cleanToken("﻿ghp_abc‍")).toBe("ghp_abc");
    expect(cleanToken("ghp_ abc def")).toBe("ghp_abcdef");
  });

  it("leaves a genuinely foreign character in place — it's the user's to fix, not ours to guess", () => {
    expect(cleanToken("ghp_abc…def")).toBe("ghp_abc…def");
  });
});
