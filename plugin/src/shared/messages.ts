/**
 * Typed message protocol between the Figma plugin sandbox and the React UI.
 *
 * Plugin → UI:  figma.ui.postMessage(msg)
 * UI → Plugin:  parent.postMessage({ pluginMessage: msg }, '*')
 */

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
  valuesByMode: Record<string, unknown>
  collectionId: string
  collectionName: string
}

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
  | { type: 'CLOSE' }
