import { describe, expect, it } from "vitest";
import { wrapBrickStyle } from "../src/brick.js";

describe("wrapBrickStyle", () => {
  it("applies the CONFIG style language to a neutral prompt", () => {
    const style = "SENTINEL toy-brick diorama styling";
    const scene = "A mayor at a podium in front of a city bus.";
    const wrapped = wrapBrickStyle(scene, style);

    // Both the config-provided style and the neutral scene survive into the output.
    expect(wrapped).toContain(style);
    expect(wrapped).toContain(scene);
  });

  it("takes its style text from the argument, not a hardcoded constant", () => {
    const scene = "A quiet harbor at dawn.";
    const a = wrapBrickStyle(scene, "STYLE-A");
    const b = wrapBrickStyle(scene, "STYLE-B");

    expect(a).toContain("STYLE-A");
    expect(a).not.toContain("STYLE-B");
    expect(b).toContain("STYLE-B");
    expect(a).not.toBe(b);
  });

  it("trims both parts and joins them deterministically", () => {
    expect(wrapBrickStyle("  scene here  ", "  style here  ")).toBe(
      "style here Scene: scene here",
    );
  });

  it("returns just the style when the scene is empty", () => {
    expect(wrapBrickStyle("   ", "only style")).toBe("only style");
  });
});
