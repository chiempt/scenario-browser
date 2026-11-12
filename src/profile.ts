import os from 'node:os';
import path from 'node:path';
import { mkdir, readdir } from 'node:fs/promises';
import { launchPersistentContext } from 'cloakbrowser';
import type { BrowserContext } from 'playwright-core';

export const profilesDir = (): string => process.env.SCENARIO_BROWSER_PROFILES ?? path.join(os.homedir(), '.scenario-browser', 'profiles');

const validName = (name: string): string => {
  if (!/^[\w.-]{1,64}$/.test(name) || name === '.' || name === '..') throw new Error(`invalid profile name "${name}" (use letters, digits, . _ -)`);
  return name;
};

export const profilePath = (name: string): string => path.join(profilesDir(), validName(name));

export const listProfiles = async (): Promise<string[]> =>
  (await readdir(profilesDir(), { withFileTypes: true }).catch(() => [])).filter((d) => d.isDirectory()).map((d) => d.name).sort();

/** Opens a persistent CloakBrowser profile (cookies, logins and storage survive between runs). */
export const openProfile = async (name: string, opts: { headless?: boolean } = {}): Promise<BrowserContext> => {
  const dir = profilePath(name);
  await mkdir(dir, { recursive: true });
  return launchPersistentContext({ userDataDir: dir, headless: opts.headless ?? false });
};
