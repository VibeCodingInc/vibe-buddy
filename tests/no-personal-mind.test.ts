// The founder-only Personal Mind talks to a private machine and is not part
// of the public release build (owner decision, 2026-11-20). It lives on in
// git history only. This pins its absence: no renderer client, no native
// module, no registered command, no capability grant toward a private origin.
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '..');
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });

describe('Personal Mind is not in the release build', () => {
  it('has no renderer client and no native module', () => {
    expect(existsSync(join(root, 'src/lib/mindClient.ts'))).toBe(false);
    expect(existsSync(join(root, 'src-tauri/src/mind.rs'))).toBe(false);
  });

  it('registers no Mind command and declares no Mind module', () => {
    const main = readFileSync(join(root, 'src-tauri/src/main.rs'), 'utf8');
    expect(main).not.toMatch(/^\s*mod mind\s*;/m);
    expect(main).not.toMatch(/mind::/);
  });

  it('no renderer source invokes a Mind command or imports the Mind client', () => {
    for (const file of walk(join(root, 'src'))) {
      if (!/\.(ts|tsx)$/.test(file)) continue;
      const src = readFileSync(file, 'utf8');
      expect(src, file).not.toMatch(/['"]mind_(prime|facet|trace)['"]/);
      expect(src, file).not.toMatch(/mindClient/);
    }
  });

  it('no capability grants the renderer a loopback or private-network origin', () => {
    for (const file of walk(join(root, 'src-tauri/capabilities'))) {
      const text = readFileSync(file, 'utf8');
      expect(text, file).not.toMatch(/127\.0\.0\.1|localhost|:7788|\b10\.\d+\.|\b100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|\b192\.168\./);
    }
  });
});
