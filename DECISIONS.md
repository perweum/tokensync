# Design Decisions & Progress Log

This document records the core architectural decisions, design guidelines, and changelog updates for the **Token Sync** project.

---

## 1. Core Architectural Decisions

### Native Figma Collection Mapping (Why not Token Studio?)
* **Decision**: We map Figma variable collections directly to W3C Design Token Community Group (DTCG) standard JSON structures.
* **Rationale**: Token Studio relies on proprietary internal token sets and requires the plugin layer to resolve aliases. Token Sync eliminates the plugin dependency for runtime compilation by mapping collections directly to standard file scopes, empowering developers to compile tokens natively.

### Dynamic Metadata-driven Collections
* **Decision**: Avoid hardcoding collection names (like "Primitives", "Semantic"). Instead, collection names are dynamically read from `metadata.json` under `figma.collections`.
* **Rationale**: Enables users to start from scratch with their own named collections without breaking the synchronization engine.

### Wiping Legacy N×M Modes
* **Decision**: Removed legacy `Legacy N×M brand×theme modes` rendering selector blocks and nested directories in `semantic/`.
* **Rationale**: Standardizes compilations to a flat theme structure (`semantic/{theme}.json`), simplifying file structures and preventing bloated CSS/JS selector outputs.

### Selective Syncing / Ignored Collections
* **Decision**: Added `ignoredCollections?: string[]` configuration in `metadata.json`.
* **Rationale**: Allows teams to mark certain collections (e.g., read-only core primitives) to be ignored during Pull/Push sync diff actions. Crucially, the platform compilers (CSS, JS, Dart, Swift) still receive the complete collection dataset to successfully resolve references.

---

## 2. Changelog & Implementation Progress

### July 2026
* **Selective Syncing**: Added filtering in `Sync.tsx` (pull/push flows) to ignore collections listed in `ignoredCollections`.
* **Tests**: Verified metadata parsing of `ignoredCollections` in `token-merger.test.ts`.

### June 2026
* **Swift Platform Transformer**: Developed a native Swift generator compiling primitives, globals, and semantic color schemes into native SwiftUI compatible static structs with a self-contained hex resolver.
* **iOS Integration Documentation**: Documented compiler targets and added an iOS/SwiftUI usage guide to the project README.
* **Legacy Cleanup**: Cleaned up the `figma-to-tokens` mapping rules and deleted deprecated directory parsing code.
* **Description Syncing**: Mapped variable description metadata to W3C `$description` properties on export.
