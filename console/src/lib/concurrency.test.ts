import { describe, expect, it } from "vitest";
import { mapLimit } from "./concurrency";

describe("mapLimit", () => {
  it("never runs more than the limit at once, and runs every item", async () => {
    let active = 0;
    let peak = 0;
    const done: number[] = [];
    await mapLimit([1, 2, 3, 4, 5, 6, 7, 8, 9], 4, async (n) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5 - (n % 3)));
      active--;
      done.push(n);
    });
    expect(peak).toBe(4);
    expect(done.sort()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
  it("copes with nothing, fewer items than lanes, and a silly limit", async () => {
    await mapLimit([], 4, async () => {
      throw new Error("never");
    });
    const seen: number[] = [];
    await mapLimit([1, 2], 10, async (n) => void seen.push(n));
    await mapLimit([3], 0, async (n) => void seen.push(n));
    expect(seen.sort()).toEqual([1, 2, 3]);
  });
});
