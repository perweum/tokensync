import { Button } from "./Button";
import { IconArrowLeft } from "../icons";
import { color, font, space } from "../theme";

/**
 * Screen title, with an optional Back link stacked above it (not inline
 * beside it) so both flush-align to the same left edge as the body content
 * below — an inline "← Back  Title" row reads as if Back has extra
 * left-margin, because the button's own hit-padding sits inside the
 * container's padding on top of it.
 */
export function ViewHeader({ title, onBack }: { title: string; onBack?: () => void }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      {onBack && (
        <Button
          variant="ghost"
          size="compact"
          icon={<IconArrowLeft size={11} />}
          onClick={onBack}
          style={{ alignSelf: "flex-start", marginLeft: -space.sm, marginTop: -2 }}
        >
          Back
        </Button>
      )}
      <h2 style={{ margin: 0, fontWeight: 600, fontSize: font.size.xl, color: color.text.primary }}>
        {title}
      </h2>
    </div>
  );
}
