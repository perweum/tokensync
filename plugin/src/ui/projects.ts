import type { Project } from "./App";
import { normalizeRepo, cleanToken } from "./githubInput";

/**
 * Parse the persisted `tokenspark:projects` value.
 *
 * Returns `[]` when nothing was ever saved (absent/empty), the projects when
 * the stored value is a well-formed array, and `null` when it exists but is
 * unreadable — invalid JSON, not an array, or an entry that isn't a project.
 * Callers must treat `null` differently from `[]`: an empty list is safe to
 * persist back, but writing `[]` over an unreadable value would destroy every
 * saved project and its access token.
 */
export function parseStoredProjects(raw: string | null | undefined): Project[] | null {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const wellFormed = parsed.every(
      (p) => typeof p === "object" && p !== null && typeof (p as Project).id === "string",
    );
    return wellFormed ? (parsed as Project[]).map(repairProject) : null;
  } catch {
    return null;
  }
}

/**
 * A project saved before Repository/Token cleaning existed may hold a pasted
 * URL or a token with an invisible character — neither can ever connect, and
 * the user would have to notice and retype them. Fixed on load; a repo that
 * can't be read as owner/name is left exactly as saved rather than guessed at.
 */
function repairProject(project: Project): Project {
  return {
    ...project,
    repo: normalizeRepo(project.repo) ?? project.repo,
    pat: cleanToken(project.pat ?? ""),
  };
}
