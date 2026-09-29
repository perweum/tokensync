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
