/**
 * Introduction-on-launch contract.
 *
 * The installed app must replay the introduction every time it is opened,
 * which means the decision cannot depend on `introSeen`. These assertions lock
 * the two pure helpers that decision is built from, plus the pre-hydration boot
 * shield that keeps the console from painting ahead of the intro.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_APPEARANCE,
  isStandaloneLaunch,
  storedMode,
} from '../src/components/christmas/prefs.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative: string) => readFileSync(path.join(root, relative), 'utf8');

const provider = read('src/components/christmas/provider.tsx');
const css = read('src/app/globals.css');

/** Minimal window stand-in: only the members the helper touches. */
function withWindow(
  value: { displayModes?: string[]; standalone?: boolean },
  run: () => void,
) {
  const modes = new Set(value.displayModes ?? []);
  const previous = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = {
    matchMedia: (query: string) => ({
      matches: Array.from(modes).some((mode) => query.includes(`display-mode: ${mode}`)),
    }),
    navigator: { standalone: value.standalone },
  };
  try {
    run();
  } finally {
    (globalThis as { window?: unknown }).window = previous;
  }
}

test('an installed app is recognised in every standalone display mode', () => {
  for (const mode of ['standalone', 'window-controls-overlay', 'fullscreen']) {
    withWindow({ displayModes: [mode] }, () => {
      assert.equal(isStandaloneLaunch(), true, `display-mode: ${mode} must count as installed`);
    });
  }
});

test('a browser tab and iOS home-screen flag are told apart', () => {
  withWindow({}, () => assert.equal(isStandaloneLaunch(), false));
  withWindow({ standalone: true }, () => assert.equal(isStandaloneLaunch(), true));
});

test('the device mode wins over the server default, and defaults when absent', () => {
  assert.equal(storedMode({ mode: 'off' }, DEFAULT_APPEARANCE), 'off');
  assert.equal(storedMode({}, DEFAULT_APPEARANCE), 'on');
  assert.equal(storedMode({ mode: 'garbage' }, DEFAULT_APPEARANCE), 'on');
});

test('the launch intro is not gated by introSeen', () => {
  // introSeen may only appear in the browser first-run branch, never in the
  // standalone branch that runs on mount.
  const launchBranch = provider.slice(
    provider.indexOf('Installed-app launch'),
    provider.indexOf('First-run introduction'),
  );
  assert.ok(launchBranch.length > 0, 'the installed-app launch branch is missing');
  // Drop the prose: the doc comment explains introSeen, the code must not read it.
  const code = launchBranch
    .slice(launchBranch.indexOf('*/') + 2)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
  assert.ok(!code.includes('introSeen'), 'a launch must not be suppressed by introSeen');
  assert.match(code, /setIntroOpen\(true\)/);
});

test('the boot shield exists in SSR markup and is scoped to installed apps', () => {
  assert.match(provider, /className="xmas-boot"/);
  assert.match(css, /\.xmas-boot\s*\{[^}]*display:\s*none/);
  assert.match(css, /@media[^{]*display-mode:\s*standalone[^{]*\{[\s\S]*?\.xmas-boot/);
  assert.match(css, /html\[data-xmas-boot="done"\]\s+\.xmas-boot\s*\{[^}]*display:\s*none/);
});
