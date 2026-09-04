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
