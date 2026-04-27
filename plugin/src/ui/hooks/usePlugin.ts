/**
 * Hook for communicating with the Figma plugin sandbox.
 * Sends messages to the plugin and listens for responses.
 */

import { useEffect, useCallback } from "react";
import type { UIMessage, PluginMessage } from "../../shared/messages";

export function useSendMessage() {
  return useCallback((msg: UIMessage) => {
    parent.postMessage({ pluginMessage: msg }, "*");
  }, []);
}

export function usePluginMessage(handler: (msg: PluginMessage) => void) {
  useEffect(() => {
    const listener = (event: MessageEvent) => {
      const msg = event.data?.pluginMessage as PluginMessage | undefined;
      if (msg) handler(msg);
    };
    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
  }, [handler]);
}
