"use strict";
/**
 * Typed message protocol between the Figma plugin sandbox and the React UI.
 *
 * Plugin → UI:  figma.ui.postMessage(msg)
 * UI → Plugin:  parent.postMessage({ pluginMessage: msg }, '*')
 */
Object.defineProperty(exports, "__esModule", { value: true });
