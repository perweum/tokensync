/**
 * Shared icon set — thin wrappers around lucide-react (MIT, tree-shakeable:
 * only the icons actually imported below end up in the bundle), not
 * hand-drawn inline SVGs. The previous set was hand-authored path data with
 * no visual design tool to check it against, which is exactly how the old
 * `?` icon ended up looking off. Pull any new icon from lucide's own set
 * (https://lucide.dev/icons) and wrap it here the same way, rather than
 * hand-drawing a new one.
 */

import {
  ChevronRight,
  Check,
  X,
  RefreshCw,
  Plus,
  Minus,
  ArrowLeft,
  ArrowRight,
  HelpCircle,
  type LucideIcon,
} from "lucide-react";
import type { CSSProperties } from "react";

export interface IconProps {
  size?: number;
  style?: CSSProperties;
  label?: string;
}

/** Every icon below renders through here — fixed stroke width and
 * `currentColor` (lucide's default) so a newly-wrapped icon automatically
 * matches the existing set instead of needing its own tuning. */
function Icon({ icon: Lucide, size = 14, style, label }: IconProps & { icon: LucideIcon }) {
  return (
    <Lucide
      size={size}
      strokeWidth={1.8}
      style={{ flexShrink: 0, display: "block", ...style }}
      role={label ? "img" : "presentation"}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    />
  );
}

/** Chevron pointing right by default; rotate 90deg via `expanded` to point down. */
export function IconChevron({ expanded, ...props }: IconProps & { expanded?: boolean }) {
  return (
    <Icon
      icon={ChevronRight}
      {...props}
      style={{
        transition: "transform 120ms ease",
        transform: expanded ? "rotate(90deg)" : "none",
        ...props.style,
      }}
    />
  );
}

export function IconCheck(props: IconProps) {
  return <Icon icon={Check} {...props} />;
}

export function IconClose(props: IconProps) {
  return <Icon icon={X} {...props} />;
}

export function IconRefresh(props: IconProps) {
  return <Icon icon={RefreshCw} {...props} />;
}

export function IconPlus(props: IconProps) {
  return <Icon icon={Plus} {...props} />;
}

export function IconMinus(props: IconProps) {
  return <Icon icon={Minus} {...props} />;
}

export function IconArrowLeft(props: IconProps) {
  return <Icon icon={ArrowLeft} {...props} />;
}

export function IconArrowRight(props: IconProps) {
  return <Icon icon={ArrowRight} {...props} />;
}

export function IconHelp(props: IconProps) {
  return <Icon icon={HelpCircle} {...props} />;
}
