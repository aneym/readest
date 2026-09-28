// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const appRoot = process.cwd();
const manifest = readFileSync(
  resolve(appRoot, 'src-tauri/gen/android/app/src/main/AndroidManifest.xml'),
  'utf8',
);
const buildScript = readFileSync(resolve(appRoot, '../../scripts/household-build.sh'), 'utf8');

describe('household Android privacy configuration', () => {
  it('disables WebView Safe Browsing and opts out of WebView metrics', () => {
    expect(manifest).toMatch(
      /<meta-data\s+android:name="android\.webkit\.WebView\.EnableSafeBrowsing"\s+android:value="false"\s*\/>/,
    );
    expect(manifest).toMatch(
      /<meta-data\s+android:name="android\.webkit\.WebView\.MetricsOptOut"\s+android:value="true"\s*\/>/,
    );
  });

  it('removes shell Sentry DSNs and refuses configured crash reporting', () => {
    expect(buildScript).toMatch(/\bunset SENTRY_DSN\b/);
    expect(buildScript).toContain(
      'household-build: SENTRY_DSN is set in .env.local; household builds ship no crash reporting',
    );
  });
});
