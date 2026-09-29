import type { Project } from "./App";

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
    return wellFormed ? (parsed as Project[]) : null;
  } catch {
    return null;
  }
}
