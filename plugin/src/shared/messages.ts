/**
 * Typed message protocol between the Figma plugin sandbox and the React UI.
 *
 * Plugin → UI:  figma.ui.postMessage(msg)
 * UI → Plugin:  parent.postMessage({ pluginMessage: msg }, '*')
 */

// Type-only — typography-styles.ts imports TokenTree/TokenValue from this file,
// so this is a type-only circular reference; erased at compile time, no runtime cycle.
import type { TypographyStyle } from "./typography-styles";

// ---------------------------------------------------------------------------
// GitHub file type (used by both UI and shared parsing logic)
// ---------------------------------------------------------------------------

export interface GitHubFile {
  path: string;
  content: string; // decoded UTF-8 content
  sha: string; // needed for updates
}

// ---------------------------------------------------------------------------
// Shared token types
// ---------------------------------------------------------------------------

export interface TokenValue {
  $type: string;
  $value: string;
  $description?: string;
}

export interface TokenTree {
  /**
   * A group may carry `$`-prefixed metadata (`$description`, and — as a Token
   * Sync convention, see shared/typography-styles.ts — a group-level `$type`)
   * alongside its nested token/group children. The plain `string` arm covers
   * that metadata; parsers must skip `$`-prefixed keys explicitly rather than
   * relying on this type to exclude them.
   */
  [key: string]: TokenValue | TokenTree | string;
}

export interface FigmaVariable {
  id: string;
  name: string;
  resolvedType: "COLOR" | "FLOAT" | "STRING" | "BOOLEAN";
  /** Raw Figma values per modeId. May be RGBA, number, string, or VariableAlias. */
  valuesByMode: Record<string, FigmaVariableValue>;
  collectionId: string;
  collectionName: string;
  description?: string;
}

/** Possible raw value types returned by the Figma Variables API. */
export type FigmaVariableValue =
  | { r: number; g: number; b: number; a?: number } // COLOR (alpha optional — Figma returns RGB or RGBA)
  | number // FLOAT
  | string // STRING
  | boolean // BOOLEAN
  | { type: "VARIABLE_ALIAS"; id: string }; // alias reference

export interface FigmaVariableCollection {
  id: string;
  name: string;
  modes: Array<{ modeId: string; name: string }>;
  variableIds: string[];
}

// ---------------------------------------------------------------------------
// Messages from Plugin → UI
// ---------------------------------------------------------------------------

export type PluginMessage =
  | {
      type: "COLLECTIONS_LOADED";
      collections: FigmaVariableCollection[];
      variables: FigmaVariable[];
      /** Local Text Styles converted to Token Sync's typography style shape — see shared/typography-styles.ts */
      typographyStyles: TypographyStyle[];
    }
  | {
      type: "TOKENS_APPLIED";
      count: number;
      removed: number;
      errors: string[];
    }
  | {
      type: "TEXT_STYLES_APPLIED";
      count: number;
      errors: string[];
    }
  | {
      type: "STORAGE_LOADED";
      key: string;
      value: string | null;
    }
  | {
      type: "ERROR";
      message: string;
      context?: string;
    };

// ---------------------------------------------------------------------------
// Messages from UI → Plugin
// ---------------------------------------------------------------------------

export type UIMessage =
  | { type: "GET_COLLECTIONS" }
  | {
      type: "APPLY_TOKENS";
      tokens: TokenTree;
      /** Resolved values for tokens that contain {refs} — used as fallback when alias target not found. */
      resolvedValues?: Record<string, string>;
      collectionId: string;
      modeId: string;
      removedPaths?: string[]; // dot-notation paths of tokens removed from GitHub
      cleanApply?: boolean; // delete all existing variables first, then recreate sorted
    }
  | {
      type: "APPLY_TEXT_STYLES";
      styles: TypographyStyle[];
      /** ${path}.${field} -> resolved value, for refs that can't be bound directly — same idea as APPLY_TOKENS' resolvedValues */
      resolvedFallback?: Record<string, string>;
    }
  | { type: "LOAD_STORAGE"; key: string }
  | { type: "SAVE_STORAGE"; key: string; value: string }
  | { type: "CLOSE" };
