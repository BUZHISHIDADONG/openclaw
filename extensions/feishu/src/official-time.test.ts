import { describe, expect, it, vi } from "vitest";
import { parseRelativeTimeRange } from "./official-time.js";

describe("parseRelativeTimeRange", () => {
  it("supports day_before_yesterday", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-24T10:00:00+08:00"));
    try {
      const range = parseRelativeTimeRange("day_before_yesterday");
      expect(range).toEqual({
        start: "1774108800",
        end: "1774195200",
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
