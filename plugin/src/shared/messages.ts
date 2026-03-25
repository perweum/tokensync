/**
 * Typed message protocol between the Figma plugin sandbox and the React UI.
 *
 * Plugin → UI:  figma.ui.postMessage(msg)
 * UI → Plugin:  parent.postMessage({ pluginMessage: msg }, '*')
 */

// ---------------------------------------------------------------------------
// GitHub file type (used by both UI and shared parsing logic)
// ---------------------------------------------------------------------------

export interface GitHubFile {
  path: string
  content: string  // decoded UTF-8 content
  sha: string      // needed for updates
}

// ---------------------------------------------------------------------------
// Shared token types
// ---------------------------------------------------------------------------

export interface TokenValue {
  $type: string
  $value: string
  $description?: string
}

export interface TokenTree {
  [key: string]: TokenValue | TokenTree
}

export interface FigmaVariable {
  id: string
  name: string
  resolvedType: 'COLOR' | 'FLOAT' | 'STRING' | 'BOOLEAN'
  /** Raw Figma values per modeId. May be RGBA, number, string, or VariableAlias. */
  valuesByMode: Record<string, FigmaVariableValue>
  collectionId: string
  collectionName: string
}

/** Possible raw value types returned by the Figma Variables API. */
export type FigmaVariableValue =
  | { r: number; g: number; b: number; a?: number }  // COLOR (alpha optional — Figma returns RGB or RGBA)
  | number                                             // FLOAT
  | string                                             // STRING
  | boolean                                            // BOOLEAN
  | { type: 'VARIABLE_ALIAS'; id: string }             // alias reference

export interface FigmaVariableCollection {
  id: string
  name: string
  modes: Array<{ modeId: string; name: string }>
  variableIds: string[]
}

// ---------------------------------------------------------------------------
// Messages from Plugin → UI
// ---------------------------------------------------------------------------

export type PluginMessage =
  | {
      type: 'COLLECTIONS_LOADED'
      collections: FigmaVariableCollection[]
      variables: FigmaVariable[]
    }
  | {
      type: 'TOKENS_APPLIED'
      count: number
      errors: string[]
    }
  | {
      type: 'STORAGE_LOADED'
      key: string
      value: string | null
    }
  | {
      type: 'ERROR'
      message: string
      context?: string
    }

// ---------------------------------------------------------------------------
// Messages from UI → Plugin
// ---------------------------------------------------------------------------

export type UIMessage =
  | { type: 'GET_COLLECTIONS' }
  | {
      type: 'APPLY_TOKENS'
      tokens: TokenTree
      collectionId: string
      modeId: string
    }
  | { type: 'LOAD_STORAGE'; key: string }
  | { type: 'SAVE_STORAGE'; key: string; value: string }
  | { type: 'CLOSE' }
