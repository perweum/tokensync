import { describe, it, expect } from "vitest";
import { decodeBase64Utf8, encodeUtf8Base64 } from "./useGitHub";

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
