/**
 * Small spot illustrations for the onboarding wizard and Help view — flat
 * shapes built from theme colors, not the blurred/gradient logomark style
 * of favicon.svg (checked directly: that's a one-off brand mark, not a
 * pattern meant to extend across five different step illustrations).
 * Each is a fixed 160x96 viewBox so they drop into the same-size slot on
 * every step without per-step layout tweaks.
 */
import { color } from "./theme";

interface ArtProps {
  style?: React.CSSProperties;
}

function Frame({ style, children }: ArtProps & { children: React.ReactNode }) {
  return (
    <svg
      width={160}
      height={96}
      viewBox="0 0 160 96"
      fill="none"
      style={{ display: "block", ...style }}
      role="presentation"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

/** Welcome step — a Figma-canvas shape and a repo shape, joined by a dashed
 * arc: the plugin's whole job in one picture, before any of the words. */
export function WelcomeArt(props: ArtProps) {
  return (
    <Frame {...props}>
      <rect
        x="20"
        y="28"
        width="44"
        height="44"
        rx="10"
        fill={color.surface.subtle}
        stroke={color.border.default}
      />
      {/* Frame corner brackets — a design-canvas idiom (crop/viewfinder marks)
          rather than an attempt at Figma's own logo. */}
      <path
        d="M32 38v-4a2 2 0 0 1 2-2h4M52 32h4a2 2 0 0 1 2 2v4M58 54v4a2 2 0 0 1-2 2h-4M38 60h-4a2 2 0 0 1-2-2v-4"
        stroke={color.accent.default}
        strokeWidth="2"
        strokeLinecap="round"
      />
      <rect
        x="38"
        y="40"
        width="12"
        height="12"
        rx="2"
        fill={color.accent.default}
        opacity="0.35"
      />
      <rect
        x="96"
        y="28"
        width="44"
        height="44"
        rx="10"
        fill={color.surface.subtle}
        stroke={color.border.default}
      />
      {/* "</>" — a repo/code shorthand, generic rather than any specific
          host's mark. */}
      <path
        d="M110 42l-6 8 6 8M126 42l6 8-6 8"
        stroke={color.accent.default}
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M66 42c10-10 18-10 28 0"
        stroke={color.accent.default}
        strokeWidth="1.6"
        strokeDasharray="1 5"
        strokeLinecap="round"
      />
      <circle cx="80" cy="34" r="2.5" fill={color.accent.default} />
    </Frame>
  );
}

/** Name step — a plain label/tag, since this step is just "what do you call
 * this project". */
export function NameArt(props: ArtProps) {
  return (
    <Frame {...props}>
      <path
        d="M44 34h48l16 14-16 14H44a6 6 0 0 1-6-6V40a6 6 0 0 1 6-6z"
        fill={color.surface.subtle}
        stroke={color.border.default}
      />
      <circle cx="54" cy="48" r="3.5" fill={color.accent.default} />
      <path
        d="M70 42h28M70 54h18"
        stroke={color.border.default}
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </Frame>
  );
}

/** Connect step — a padlock over a repo shape: this is the "prove you have
 * access" step. */
export function ConnectArt(props: ArtProps) {
  return (
    <Frame {...props}>
      <rect
        x="42"
        y="36"
        width="76"
        height="36"
        rx="8"
        fill={color.surface.subtle}
        stroke={color.border.default}
      />
      <path
        d="M54 36v-4a8 8 0 0 1 8-8h36a8 8 0 0 1 8 8v4"
        stroke={color.border.default}
        strokeWidth="2"
      />
      <rect x="64" y="42" width="32" height="24" rx="6" fill={color.accent.default} />
      <path
        d="M72 42v-5a8 8 0 0 1 16 0v5"
        stroke={color.accent.default}
        strokeWidth="2.4"
        strokeLinecap="round"
      />
      <circle cx="80" cy="52" r="2.4" fill="#fff" />
      <path d="M80 54.4v3.6" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
    </Frame>
  );
}

/** Defaults step — a short settings list, standing in for branch / tokens
 * path / Figma file key. */
export function DefaultsArt(props: ArtProps) {
  const rows = [
    { y: 30, on: true },
    { y: 48, on: false },
    { y: 66, on: true },
  ];
  return (
    <Frame {...props}>
      {rows.map((row) => (
        <g key={row.y}>
          <rect
            x="34"
            y={row.y}
            width="92"
            height="12"
            rx="6"
            fill={color.surface.subtle}
            stroke={color.border.default}
          />
          <path
            d={`M46 ${row.y + 6}h24`}
            stroke={color.border.default}
            strokeWidth="2"
            strokeLinecap="round"
          />
          <circle
            cx={row.on ? 118 : 108}
            cy={row.y + 6}
            r="7"
            fill={row.on ? color.accent.default : color.surface.default}
            stroke={row.on ? "none" : color.border.default}
          />
        </g>
      ))}
    </Frame>
  );
}

/** Tips step + Help view — the existing check glyph, enlarged, inside a
 * soft ring — "you're set" without introducing a new symbol. */
export function TipsArt(props: ArtProps) {
  return (
    <Frame {...props}>
      <circle cx="80" cy="48" r="30" fill={color.surface.subtle} />
      <circle cx="80" cy="48" r="30" stroke={color.border.subtle} />
      <path
        d="M67 49l9 9 17-20"
        stroke={color.accent.default}
        strokeWidth="4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Frame>
  );
}
