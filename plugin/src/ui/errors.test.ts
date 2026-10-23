import { describe, it, expect } from "vitest";
import { describeUnreadableFiles, describeUnsupportedTokens, describeGitHubError } from "./errors";

describe("describeUnreadableFiles", () => {
  it("names the risk and lists every file", () => {
    const one = describeUnreadableFiles(["primitives/color.json"]);
    expect(one.message).toMatch(/1 token file in GitHub couldn't be read/);
    expect(one.message).toMatch(/delete Figma variables/);
    expect(one.detail).toBe("primitives/color.json");

    const two = describeUnreadableFiles(["a.json", "b.json"]);
    expect(two.message).toMatch(/2 token files/);
    expect(two.detail).toBe("a.json, b.json");
  });
});

describe("describeUnsupportedTokens", () => {
  it("explains why pulling is refused and lists where the tokens are", () => {
    const e = describeUnsupportedTokens([
      { file: "primitives/shadow.json", path: "shadow.card" },
      { file: "primitives/shadow.json", path: "shadow.flat" },
    ]);
    expect(e.message).toMatch(/2 tokens in GitHub use a value type Token Spark can't sync yet/);
    expect(e.message).toMatch(/delete Figma variables/);
    expect(e.detail).toBe(
      "primitives/shadow.json: shadow.card, primitives/shadow.json: shadow.flat",
    );
  });

  it("truncates a long list in the detail", () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ file: "f.json", path: `t${i}` }));
    const e = describeUnsupportedTokens(many);
    expect(e.detail).toMatch(/…and 15 more$/);
  });

  it("uses the singular for one token", () => {
    expect(describeUnsupportedTokens([{ file: "f.json", path: "a" }]).message).toMatch(
      /^1 token in GitHub uses a value type/,
    );
  });
});

describe("describeGitHubError — a request that never reached GitHub", () => {
  it("points at the inputs, not just the network, since a bad value fails the same way", () => {
    const e = describeGitHubError(new TypeError("Failed to fetch"), "fetch-branches");
    expect(e.message).toMatch(/Couldn't reach GitHub/);
    expect(e.message).toMatch(/owner\/name/);
    expect(e.detail).toBe("Failed to fetch");
  });

  it("says plainly when the browser refused the token itself", () => {
    const e = describeGitHubError(
      new TypeError(
        "Failed to execute 'fetch' on 'Window': Failed to read the 'headers' property from 'RequestInit': String contains non ISO-8859-1 code point.",
      ),
      "fetch-branches",
    );
    expect(e.message).toMatch(/token contains a character/i);
  });
});
