/**
 * Token Sync — Figma plugin main thread.
 *
 * Runs in the Figma sandbox. Has access to the `figma` global.
 * Communicates with the React UI via postMessage.
 */

import type { UIMessage, PluginMessage } from '../shared/messages'
import { getCollectionsAndVariables, applyTokensToCollection } from './figma-variables'

// ---------------------------------------------------------------------------
// Plugin initialisation
// ---------------------------------------------------------------------------

figma.showUI(__html__, {
  width: 480,
  height: 640,
  title: 'Token Sync',
})

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

figma.ui.onmessage = async (msg: UIMessage) => {
  try {
    switch (msg.type) {
      case 'GET_COLLECTIONS': {
        const { collections, variables } = await getCollectionsAndVariables()
        send({ type: 'COLLECTIONS_LOADED', collections, variables })
        break
      }

      case 'APPLY_TOKENS': {
        const count = await applyTokensToCollection(
          msg.tokens,
          msg.collectionId,
          msg.modeId,
        )
        send({ type: 'TOKENS_APPLIED', count })
        break
      }

      case 'CLOSE': {
        figma.closePlugin()
        break
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    send({ type: 'ERROR', message, context: msg.type })
  }
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function send(msg: PluginMessage) {
  figma.ui.postMessage(msg)
}
