import { expect, test } from "bun:test";
import { hasNoUserArguments } from "../src/memory-helper.ts";

test("accepts source and compiled Bun argv without user arguments", () => {
  expect(hasNoUserArguments(["/synthetic/bin/bun", "/src/memory-helper.ts"])).toBe(true);
  expect(hasNoUserArguments(["bun", "/$bunfs/root/memory-helper"])).toBe(true);
  expect(hasNoUserArguments(["bun", "/$bunfs/root/memory-helper", "unexpected"])).toBe(false);
  expect(hasNoUserArguments(["/synthetic/bin/bun", "/src/memory-helper.ts", "unexpected"])).toBe(false);
});
