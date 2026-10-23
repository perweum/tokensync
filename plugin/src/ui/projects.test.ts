import { describe, it, expect } from "vitest";
import { parseStoredProjects } from "./projects";

const project = {
  id: "p1",
  name: "DS",
  pat: "x",
  repo: "a/b",
  branch: "main",
  tokensPath: "tokens/",
  figmaFileKey: "",
};

describe("parseStoredProjects", () => {
  it("returns [] when nothing was ever saved", () => {
    expect(parseStoredProjects(null)).toEqual([]);
    expect(parseStoredProjects(undefined)).toEqual([]);
    expect(parseStoredProjects("")).toEqual([]);
  });

  it("returns the projects for a well-formed array", () => {
    expect(parseStoredProjects(JSON.stringify([project]))).toEqual([project]);
    expect(parseStoredProjects("[]")).toEqual([]);
  });

  it("returns null — not [] — for unreadable stored data, so callers can back it up instead of overwriting it", () => {
    expect(parseStoredProjects("{not json")).toBeNull();
    expect(parseStoredProjects('{"id":"p1"}')).toBeNull(); // valid JSON, not an array
    expect(parseStoredProjects('[{"name":"no id"}]')).toBeNull(); // entry isn't a project
    expect(parseStoredProjects("[null]")).toBeNull();
  });
});

describe("parseStoredProjects — repairs values saved before input cleaning existed", () => {
  const saved = (over: object) => JSON.stringify([{ ...project, ...over }]);

  it("reduces a saved repo URL to owner/name and strips junk from the saved token", () => {
    // A project saved with a pasted URL could never connect ("Failed to fetch")
    // and would otherwise stay broken until the user re-entered it by hand.
    const [p] = parseStoredProjects(
      saved({ repo: "https://github.com/bekk/designsystem/", pat: "ghp_abc\u200bdef\n" }),
    )!;
    expect(p.repo).toBe("bekk/designsystem");
    expect(p.pat).toBe("ghp_abcdef");
  });

  it("leaves a repo it can't make sense of exactly as saved", () => {
    const [p] = parseStoredProjects(saved({ repo: "not a repo" }))!;
    expect(p.repo).toBe("not a repo");
  });

  it("keeps a project with no GitHub connection (empty repo/token) untouched", () => {
    const [p] = parseStoredProjects(saved({ repo: "", pat: "" }))!;
    expect(p.repo).toBe("");
    expect(p.pat).toBe("");
  });
});
