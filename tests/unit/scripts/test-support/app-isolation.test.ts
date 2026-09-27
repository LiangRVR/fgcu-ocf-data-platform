/**
 * tests/unit/scripts/test-support/app-isolation.test.ts
 *
 * Unit coverage for `prepareIsolatedAppDir` (in
 * `scripts/test-support/supabase-isolation.mjs`), the helper that gives the
 * E2E lane an isolated Next.js build/start directory:
 *
 *   - the repository tree is copied minus a deny-list (`node_modules` is
 *     re-created as a real hardlinked tree, `.next`/`supabase`/VCS/docs/
 *     generated artifacts excluded);
 *   - NO `.env*` file is ever copied, so Next.js cannot load any project env;
 *   - `cleanup()` removes the whole workdir, so `.next` build output can never
 *     land in (or leak into) the repository.
 */
import { describe, expect, it } from "vitest";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { prepareIsolatedAppDir } from "../../../../scripts/test-support/supabase-isolation.mjs";

/** Build a fake repository root that mirrors the real project's layout. */
function makeFakeRoot() {
  const root = mkdtempSync(path.join(os.tmpdir(), "ocf-app-root-"));
  mkdirSync(path.join(root, "node_modules"), { recursive: true });
  mkdirSync(path.join(root, "node_modules", ".pnpm"), { recursive: true });
  mkdirSync(path.join(root, "node_modules", "next"), { recursive: true });
  writeFileSync(path.join(root, "node_modules", "next", "index.js"), "module.exports = {};");
  mkdirSync(path.join(root, "app"), { recursive: true });
  mkdirSync(path.join(root, "supabase"), { recursive: true });
  mkdirSync(path.join(root, ".next"), { recursive: true });
  writeFileSync(path.join(root, "package.json"), "{}");
  writeFileSync(path.join(root, "app", "page.tsx"), "export default function Page() { return null; }");
  writeFileSync(path.join(root, ".env"), "NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321");
  writeFileSync(path.join(root, ".env.local"), "SUPABASE_SERVICE_ROLE_KEY=should-not-load");
  writeFileSync(path.join(root, "tsconfig.tsbuildinfo"), "stale");
  return root;
}

describe("prepareIsolatedAppDir", () => {
  it("copies the source tree but never .env* files or generated artifacts", () => {
    const root = makeFakeRoot();
    let workdir = "";
    try {
      const appDir = prepareIsolatedAppDir({ root, label: "e2e-app" });
      workdir = appDir.workdir;
      // Source tree present.
      expect(existsSync(path.join(workdir, "package.json"))).toBe(true);
      expect(existsSync(path.join(workdir, "app", "page.tsx"))).toBe(true);
      // Project env files are NEVER copied.
      expect(existsSync(path.join(workdir, ".env"))).toBe(false);
      expect(existsSync(path.join(workdir, ".env.local"))).toBe(false);
      // Repository build artifacts and the Supabase project are never copied.
      expect(existsSync(path.join(workdir, ".next"))).toBe(false);
      expect(existsSync(path.join(workdir, "supabase"))).toBe(false);
      expect(existsSync(path.join(workdir, "tsconfig.tsbuildinfo"))).toBe(false);
      // node_modules is re-created as a REAL directory tree (hardlinked files,
      // recreated pnpm symlinks) so Turbopack's resolver accepts it and module
      // resolution is identical — never a symlink out of the project root.
      expect(lstatSync(path.join(workdir, "node_modules")).isDirectory()).toBe(true);
      expect(lstatSync(path.join(workdir, "node_modules")).isSymbolicLink()).toBe(false);
      expect(existsSync(path.join(workdir, "node_modules", "next"))).toBe(true);
      expect(existsSync(path.join(workdir, "node_modules", ".pnpm"))).toBe(true);
      // cleanup() removes the whole workdir.
      appDir.cleanup();
      expect(existsSync(workdir)).toBe(false);
    } finally {
      if (workdir && existsSync(workdir)) rmSync(workdir, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("throws a clear blocker when node_modules is missing", () => {
    const root = makeFakeRoot();
    rmSync(path.join(root, "node_modules"), { recursive: true, force: true });
    try {
      expect(() => prepareIsolatedAppDir({ root })).toThrow(/Expected node_modules/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});