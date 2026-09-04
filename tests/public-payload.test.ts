import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";

const root = join(import.meta.dir, "..");
const ignoredDirectories = new Set([".git", "node_modules", "dist", "coverage"]);
const binaryExtensions = new Set([".png", ".webp", ".jpg", ".jpeg", ".gif", ".ico", ".woff", ".woff2"]);

// Real detector classes instead of a hardcoded obfuscated-marker list: a marker list is
// fragile because any code sample that assembles a forbidden value from string-literal
// parts (e.g. a private hostname split into two quoted fragments and concatenated)
// reconstructs the real value while never containing it as a contiguous literal, so a
// plain `.not.toContain()` check misses it.
const PRIVATE_ABSOLUTE_PATH = /(?<![\w-])\/(?:home|Users|root)\/[^\s"'`]+/;
const PERSONAL_EMAIL = /[A-Za-z0-9._%+-]+@(?!example\.(?:com|test|org)\b)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const PRIVATE_KEY_BLOCK = /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----|BEGIN OPENSSH PRIVATE KEY/;
const CLOUD_HOSTNAME_PATTERN = /\b[a-z]+-\d+gb(?:-[a-z0-9]+)*\b|\btail[0-9a-f]{4,}\b/i;

const SENSITIVE_PATTERNS: Array<[string, RegExp]> = [
  ["absolute user path", PRIVATE_ABSOLUTE_PATH],
  ["personal email", PERSONAL_EMAIL],
  ["private key block", PRIVATE_KEY_BLOCK],
  ["cloud/tailnet-style hostname", CLOUD_HOSTNAME_PATTERN],
];

// Guards against the exact leak class above: a string-literal array immediately joined,
// which is a common way sensitive text ends up "safely" split apart in source but still
// fully reconstructable. Evaluate every such expression textually and re-check the
// reconstructed value against the same sensitive patterns.
const JOIN_EXPRESSION = /\[\s*((?:"[^"]*"|'[^']*')(?:\s*,\s*(?:"[^"]*"|'[^']*'))*)\s*\]\s*\.\s*join\(\s*(?:"([^"]*)"|'([^']*)')?\s*\)/g;
const STRING_LITERAL = /"([^"]*)"|'([^']*)'/g;

function reconstructedJoinValues(contents: string): string[] {
  const values: string[] = [];
  for (const match of contents.matchAll(JOIN_EXPRESSION)) {
    const separator = match[2] ?? match[3] ?? "";
    const items: string[] = [];
    for (const item of match[1]!.matchAll(STRING_LITERAL)) items.push(item[1] ?? item[2] ?? "");
    values.push(items.join(separator));
  }
  return values;
}

// Every reconstructed class is a hard rule everywhere except one legitimate defensive
// pattern used only inside test files: `expect(unit).not.toContain(["/home", "dev"].join("/"))`
// searches generated config output for a forbidden hardcoded path. That is a safe,
// intentional use of the technique, so the absolute-path class is checked separately
// and skipped for files under tests/.
const RECONSTRUCTION_PATTERNS = SENSITIVE_PATTERNS.filter(([label]) => label !== "absolute user path");
const TESTS_DIRECTORY_PREFIX = `${join(root, "tests")}/`;
const SELF_PATH = join(import.meta.dir, "public-payload.test.ts");

function textFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) files.push(...textFiles(join(directory, entry.name)));
      continue;
    }
    const path = join(directory, entry.name);
    // Self-excluded: this file necessarily documents the detector patterns themselves
    // (regex source, comments) and would otherwise always match its own rules.
    if (path === SELF_PATH) continue;
    if (!binaryExtensions.has(extname(entry.name).toLowerCase())) files.push(path);
  }
  return files;
}

test("public payload contains no private paths, emails, keys or infra hostnames", () => {
  for (const path of textFiles(root)) {
    const contents = readFileSync(path, "utf8");
    for (const [label, pattern] of SENSITIVE_PATTERNS) {
      const match = pattern.exec(contents);
      expect(match, `${path} contains a ${label}: ${match?.[0]}`).toBeNull();
    }
  }
});

test("no string-literal array reconstructs a private email, key or hostname anywhere", () => {
  for (const path of textFiles(root)) {
    const contents = readFileSync(path, "utf8");
    for (const reconstructed of reconstructedJoinValues(contents)) {
      for (const [label, pattern] of RECONSTRUCTION_PATTERNS) {
        expect(pattern.test(reconstructed), `${path} reconstructs a ${label} via .join(): ${reconstructed}`).toBe(false);
      }
    }
  }
});

test("no string-literal array reconstructs a private path outside test-assertion files", () => {
  for (const path of textFiles(root)) {
    if (path.startsWith(TESTS_DIRECTORY_PREFIX)) continue;
    const contents = readFileSync(path, "utf8");
    for (const reconstructed of reconstructedJoinValues(contents)) {
      expect(PRIVATE_ABSOLUTE_PATH.test(reconstructed), `${path} reconstructs an absolute user path via .join(): ${reconstructed}`).toBe(false);
    }
  }
});

test("private runtime workspaces and artifacts are excluded", () => {
  for (const path of ["launchpad", ".superpowers", "docs/superpowers", "docs/design", ".omp", "monitor.sqlite3", "monitor.sqlite3-wal", "monitor.sqlite3-shm"]) {
    expect(existsSync(join(root, path))).toBe(false);
  }
  expect(statSync(join(root, "screenshots"), { throwIfNoEntry: false })?.isDirectory()).toBe(true);
  for (const screenshot of ["healthy.webp", "pressure.webp", "unavailable.webp"]) {
    expect(existsSync(join(root, "screenshots", screenshot))).toBe(true);
  }
});
