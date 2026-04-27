/**
 * Token Sync — Figma plugin main thread.
 *
 * Runs in the Figma sandbox. Has access to the `figma` global.
 * Communicates with the React UI via postMessage.
 */

import type { UIMessage, PluginMessage } from "../shared/messages";
import { getCollectionsAndVariables, applyTokensToCollection } from "./figma-variables";

// ---------------------------------------------------------------------------
// Plugin initialisation
// ---------------------------------------------------------------------------

figma.showUI(__html__, {
  width: 480,
  height: 640,
  title: "Token Sync",
});

// ---------------------------------------------------------------------------
// Serial apply queue
// Figma's async onmessage handler can run concurrently when the UI sends
// multiple APPLY_TOKENS messages in quick succession. This queue ensures
// each apply completes fully before the next one starts — critical so that
// Primitives variables exist in Figma before Semantic aliases look them up.
// ---------------------------------------------------------------------------

type ApplyTask = () => Promise<void>;
const applyQueue: ApplyTask[] = [];
let applyBusy = false;

function enqueueApply(task: ApplyTask) {
  applyQueue.push(task);
  if (!applyBusy) drainApplyQueue();
}

async function drainApplyQueue() {
  applyBusy = true;
  while (applyQueue.length > 0) {
    const task = applyQueue.shift()!;
    try {
      await task();
    } catch (err) {
      // Unexpected error in task — report to UI and continue draining
      send({
        type: "ERROR",
        message: err instanceof Error ? err.message : String(err),
        context: "APPLY_TOKENS",
      });
    }
  }
  applyBusy = false;
}

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

figma.ui.onmessage = async (msg: UIMessage) => {
  try {
    switch (msg.type) {
      case "GET_COLLECTIONS": {
        const { collections, variables } = await getCollectionsAndVariables();
        send({ type: "COLLECTIONS_LOADED", collections, variables });
        break;
      }

      case "APPLY_TOKENS": {
        enqueueApply(async () => {
          const { count, removed, errors } = await applyTokensToCollection(
            msg.tokens,
            msg.collectionId,
            msg.modeId,
            msg.removedPaths,
            msg.cleanApply,
            msg.resolvedValues,
          );
          send({ type: "TOKENS_APPLIED", count, removed, errors });
        });
        break;
      }

      case "LOAD_STORAGE": {
        const value = (await figma.clientStorage.getAsync(msg.key)) as string | undefined;
        send({ type: "STORAGE_LOADED", key: msg.key, value: value ?? null });
        break;
      }

      case "SAVE_STORAGE": {
        await figma.clientStorage.setAsync(msg.key, msg.value);
        break;
      }

      case "CLOSE": {
        figma.closePlugin();
        break;
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    send({ type: "ERROR", message, context: msg.type });
  }
};

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function send(msg: PluginMessage) {
  figma.ui.postMessage(msg);
}
