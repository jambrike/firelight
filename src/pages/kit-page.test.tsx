import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { KitPage } from "./KitPage";

describe("kit gallery loading", () => {
  it("reserves every image's space and prioritizes only the main kit view", () => {
    render(<KitPage />);

    const main = screen.getByRole("img", {
      name: "Open Firelight kit box with the Arduino board and learning parts arranged inside",
    });
    expect(main).toHaveAttribute("width", "724");
    expect(main).toHaveAttribute("height", "480");
    expect(main).toHaveAttribute("fetchpriority", "high");
    expect(main).not.toHaveAttribute("loading", "lazy");

    for (const [name, width, height] of [
      ["Firelight kit opened to its first parts layer", "726", "484"],
      ["Top view of the printed Firelight kit box", "712", "476"],
      ["Closed Firelight kit box", "722", "484"],
    ] as const) {
      const thumbnail = screen.getByRole("img", { name });
      expect(thumbnail).toHaveAttribute("width", width);
      expect(thumbnail).toHaveAttribute("height", height);
      expect(thumbnail).toHaveAttribute("loading", "lazy");
      expect(thumbnail).toHaveAttribute("decoding", "async");
    }
  });
});
