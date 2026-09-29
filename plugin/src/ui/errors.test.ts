import { describe, it, expect } from "vitest";
import { describeUnreadableFiles } from "./errors";

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
