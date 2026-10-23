/**
 * Maps low-level failures (GitHub REST errors, Figma plugin-sandbox errors)
 * to plain-language copy for StatusBanner. Never lossy: the technical detail
 * is always preserved as `detail` alongside the friendly `message`, so a
 * user reporting a bug can still hand over the raw string.
 */
import { GitHubApiError } from "./hooks/useGitHub";

export interface DescribedError {
  message: string;
  detail?: string;
}

export type GitHubAction = "fetch-tokens" | "fetch-branches" | "create-branch" | "create-pr";

export function describeGitHubError(err: unknown, action: GitHubAction): DescribedError {
  if (err instanceof GitHubApiError) {
    return { message: githubMessage(err, action), detail: err.message };
  }
  if (err instanceof TypeError) {
    // fetch() rejects with a TypeError for network failures/CORS, with no status code.
    return {
      message: "Couldn't reach GitHub — check your internet connection and try again.",
      detail: err.message,
    };
  }
  return { message: err instanceof Error ? err.message : String(err) };
}

function githubMessage(err: GitHubApiError, action: GitHubAction): string {
  switch (err.status) {
    case 401:
      return "GitHub rejected the personal access token. Check it's correct and hasn't expired, in Settings.";
    case 403:
      return "GitHub denied access. Check the token has repo read/write permissions, or that you haven't hit a rate limit.";
    case 404:
      switch (action) {
        case "fetch-tokens":
          return "No token files found. Check the repository, branch and tokens path in Settings.";
        case "fetch-branches":
          return "Repository not found. Check the repository name in Settings.";
        case "create-branch":
          return "Repository or source branch not found. Check the repository and branch in Settings.";
        case "create-pr":
          return "Repository or branch not found. Check the repository and branch in Settings.";
      }
      break;
    case 409:
      return "GitHub couldn't complete this — something changed at the same time. Try again.";
    case 422:
      return action === "create-branch"
        ? "Couldn't create the branch — a branch with that name may already exist."
        : "GitHub rejected the request — the branch or file may be out of date. Try again.";
    case 429:
      return "GitHub rate limit reached. Wait a few minutes and try again.";
    default:
      if (err.status >= 500) return "GitHub is having issues right now. Try again in a moment.";
  }
  return `GitHub returned an unexpected error (${err.status}).`;
}

/** Friendly-ish label per UIMessage type, for prefixing plugin-sandbox ERROR messages. */
const PLUGIN_CONTEXT_LABEL: Partial<Record<string, string>> = {
  GET_COLLECTIONS: "reading Figma variables",
  APPLY_TOKENS: "applying tokens to Figma",
  APPLY_TEXT_STYLES: "applying text styles to Figma",
  LOAD_STORAGE: "loading saved settings",
  SAVE_STORAGE: "saving settings",
};

/**
 * Plugin-sandbox errors come from arbitrary internal/Figma-API exceptions —
 * there's no closed set of codes to map like GitHub's, so this only adds
 * *where* it happened, without pretending to explain *why*.
 */
export function describePluginError(message: string, context?: string): DescribedError {
  const label = context ? PLUGIN_CONTEXT_LABEL[context] : undefined;
  return label ? { message: `Something went wrong while ${label}.`, detail: message } : { message };
}

/**
 * Pull found tokens whose value has no string form (a composite shadow array,
 * a typography object). Token Spark can't apply them, so it leaves them out
 * of the comparison — which would make them look absent from GitHub, and
 * Apply deletes a Figma variable that shares a name with an "absent" token.
 * Refused for the same reason unreadable files are.
 */
export function describeUnsupportedTokens(
  tokens: Array<{ file: string; path: string }>,
): DescribedError {
  const n = tokens.length;
  const listed = tokens.slice(0, 10).map((t) => `${t.file}: ${t.path}`);
  if (n > 10) listed.push(`…and ${n - 10} more`);
  return {
    message: `${n} token${n !== 1 ? "s" : ""} in GitHub ${n !== 1 ? "use" : "uses"} a value type Token Spark can't sync yet (for example a composite shadow), so pulling now could delete Figma variables with the same names. Convert or remove ${n !== 1 ? "them" : "it"} in the repository, then pull again.`,
    detail: listed.join(", "),
  };
}

/**
 * Pull found token files it couldn't read (see parseRepository's
 * `unreadableFiles`). Refusing outright — rather than diffing without them —
 * is the point: their tokens would look "removed in GitHub", and Apply would
 * delete the matching Figma variables.
 */
export function describeUnreadableFiles(paths: string[]): DescribedError {
  const count = paths.length;
  return {
    message: `${count} token file${count !== 1 ? "s" : ""} in GitHub couldn't be read, so pulling now could delete Figma variables that do exist in GitHub. Fix ${count !== 1 ? "them" : "it"} in the repository and pull again.`,
    detail: paths.join(", "),
  };
}
