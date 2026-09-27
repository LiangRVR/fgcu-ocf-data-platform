import { describe, it, expect } from "vitest";
import { formatDate, getInitials } from "@/lib/utils/format";

describe("formatDate", () => {
  it("returns an em dash for null, undefined, and empty values", () => {
    expect(formatDate(null)).toBe("—");
    expect(formatDate(undefined)).toBe("—");
    expect(formatDate("")).toBe("—");
  });

  it("returns an em dash for unparseable or out-of-range date strings", () => {
    expect(formatDate("not-a-date")).toBe("—");
    expect(formatDate("2024-13-99")).toBe("—");
  });

  it("formats valid ISO date strings with the default pattern", () => {
    expect(formatDate("2024-03-15T12:00:00")).toBe("Mar 15, 2024");
  });

  it("formats Date objects", () => {
    const date = new Date(2024, 2, 15, 12, 0, 0);
    expect(formatDate(date)).toBe("Mar 15, 2024");
  });

  it("supports a custom pattern", () => {
    expect(formatDate("2024-03-15T12:00:00", "yyyy-MM-dd")).toBe("2024-03-15");
  });
});

describe("getInitials", () => {
  it("returns uppercase initials for a two-part name", () => {
    expect(getInitials("John Smith")).toBe("JS");
  });

  it("uppercases lowercase input", () => {
    expect(getInitials("john smith")).toBe("JS");
  });

  it("returns a single initial for single-word names", () => {
    expect(getInitials("John")).toBe("J");
  });

  it("only uses the first two name parts", () => {
    expect(getInitials("John Jacob Smith")).toBe("JJ");
  });

  it("returns an empty string for empty or blank input", () => {
    expect(getInitials("")).toBe("");
    expect(getInitials("   ")).toBe("");
  });
});