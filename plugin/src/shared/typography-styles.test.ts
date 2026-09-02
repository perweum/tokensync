import { describe, it, expect } from "vitest";
import { extractTypographyStyles } from "./typography-styles";
import type { TokenTree } from "./messages";

function leaf($type: string, $value: string) {
  return { $type, $value };
}

describe("extractTypographyStyles", () => {
  it("extracts a group marked $type: typography, matching this repo's real shape", () => {
    // Mirrors tokens/semantic/global/typography.json's text.heading.display,
    // with the opt-in marker added.
    const tree: TokenTree = {
      text: {
        heading: {
          display: {
            $type: "typography",
            fontFamily: leaf("fontFamily", "{typography.fontFamily.sans}"),
            fontWeight: leaf("fontWeight", "{typography.fontWeight.bold}"),
            fontSize: leaf("dimension", "{typography.fontSize.5xl}"),
            lineHeight: leaf("number", "{typography.lineHeight.tight}"),
            letterSpacing: leaf("dimension", "{typography.letterSpacing.tight}"),
          },
        },
      },
    };

    const styles = extractTypographyStyles(tree);

    expect(styles).toHaveLength(1);
    expect(styles[0].path).toBe("text.heading.display");
    expect(styles[0].fields.fontFamily?.$value).toBe("{typography.fontFamily.sans}");
    expect(styles[0].fields.fontWeight?.$value).toBe("{typography.fontWeight.bold}");
    expect(styles[0].fields.fontSize?.$value).toBe("{typography.fontSize.5xl}");
    expect(styles[0].fields.lineHeight?.$value).toBe("{typography.lineHeight.tight}");
    expect(styles[0].fields.letterSpacing?.$value).toBe("{typography.letterSpacing.tight}");
  });

  it("ignores an unmarked group with the exact same shape (opt-in, not pattern-matched)", () => {
    const tree: TokenTree = {
      text: {
        heading: {
          display: {
            // no $type: "typography" marker
            fontFamily: leaf("fontFamily", "{typography.fontFamily.sans}"),
            fontWeight: leaf("fontWeight", "{typography.fontWeight.bold}"),
          },
        },
      },
    };

    expect(extractTypographyStyles(tree)).toEqual([]);
  });

  it("finds multiple marked groups at different depths", () => {
    const tree: TokenTree = {
      text: {
        heading: {
          display: { $type: "typography", fontFamily: leaf("fontFamily", "A") },
        },
        body: {
          md: { $type: "typography", fontFamily: leaf("fontFamily", "B") },
        },
      },
    };

    const styles = extractTypographyStyles(tree);
    const paths = styles.map((s) => s.path).sort();
    expect(paths).toEqual(["text.body.md", "text.heading.display"]);
  });

  it("keeps only recognized field names, dropping anything else", () => {
    const tree: TokenTree = {
      display: {
        $type: "typography",
        $description: "ignored metadata key",
        fontFamily: leaf("fontFamily", "Inter"),
        someUnrelatedKey: leaf("string", "not a typography field"),
      },
    };

    const styles = extractTypographyStyles(tree);
    expect(styles).toHaveLength(1);
    expect(Object.keys(styles[0].fields)).toEqual(["fontFamily"]);
  });

  it("does not recurse into a marked group's own children looking for nested styles", () => {
    const tree: TokenTree = {
      outer: {
        $type: "typography",
        fontFamily: leaf("fontFamily", "Inter"),
        inner: {
          $type: "typography",
          fontFamily: leaf("fontFamily", "Georgia"),
        },
      },
    };

    const styles = extractTypographyStyles(tree);
    expect(styles).toHaveLength(1);
    expect(styles[0].path).toBe("outer");
  });

  it("supports all 9 recognized fields, including the two Figma can't bind", () => {
    const tree: TokenTree = {
      caption: {
        $type: "typography",
        fontFamily: leaf("fontFamily", "Inter"),
        fontWeight: leaf("fontWeight", "Regular"),
        fontSize: leaf("dimension", "12px"),
        lineHeight: leaf("number", "150"),
        letterSpacing: leaf("dimension", "0"),
        paragraphSpacing: leaf("dimension", "8px"),
        paragraphIndent: leaf("dimension", "0px"),
        textCase: leaf("string", "uppercase"),
        textDecoration: leaf("string", "none"),
      },
    };

    const styles = extractTypographyStyles(tree);
    expect(Object.keys(styles[0].fields).sort()).toEqual(
      [
        "fontFamily",
        "fontWeight",
        "fontSize",
        "lineHeight",
        "letterSpacing",
        "paragraphSpacing",
        "paragraphIndent",
        "textCase",
        "textDecoration",
      ].sort(),
    );
  });

  it("returns an empty array for a tree with no typography groups", () => {
    const tree: TokenTree = {
      color: { brand: { 500: leaf("color", "#0142FE") } },
    };
    expect(extractTypographyStyles(tree)).toEqual([]);
  });

  it("returns an empty array for an empty tree", () => {
    expect(extractTypographyStyles({})).toEqual([]);
  });
});
