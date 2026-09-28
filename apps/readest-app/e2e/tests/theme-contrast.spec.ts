import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures/base';
import { SAMPLE_EPUB } from '../fixtures/books';
import {
  EINK_THRESHOLDS,
  LCD_THRESHOLDS,
  scanContrast,
  type ContrastSample,
  type ContrastSkip,
  type Thresholds,
} from '../fixtures/contrast';
import { LibraryPage } from '../pages/LibraryPage';
import { ReaderPage } from '../pages/ReaderPage';

/**
 * Every control label must stay readable in every theme the Palma runs:
 * e-ink day, e-ink true-black night, and the LCD light and dark themes.
 *
 * Each mode is reached the way a user reaches it (theme mode from storage,
 * E-Ink Mode through the Behavior settings toggle), then the library,
 * Discover (household builds), reader chrome, sidebar and every settings
 * panel are scanned at rest and again for each control a Tab press focuses.
 *
 * Opt-in: the four modes take ~17 minutes against a dev server, so the scan
 * runs only when THEME_CONTRAST_OUT names a directory for the per-mode JSON
 * reports. Shelf chips render only in household builds
 * (NEXT_PUBLIC_HOUSEHOLD_BUILD=1).
 */

test.skip(!process.env['THEME_CONTRAST_OUT'], 'opt-in scan: set THEME_CONTRAST_OUT');

interface Mode {
  name: string;
  themeMode: 'light' | 'dark';
  /** E-ink devices default to the Contrast theme (see getInitialThemeColor). */
  themeColor: 'contrast' | 'default';
  eink: boolean;
  thresholds: Thresholds;
}

const MODES: Mode[] = [
  {
    name: 'eink-day',
    themeMode: 'light',
    themeColor: 'contrast',
    eink: true,
    thresholds: EINK_THRESHOLDS,
  },
  {
    name: 'eink-night',
    themeMode: 'dark',
    themeColor: 'contrast',
    eink: true,
    thresholds: EINK_THRESHOLDS,
  },
  {
    name: 'lcd-light',
    themeMode: 'light',
    themeColor: 'default',
    eink: false,
    thresholds: LCD_THRESHOLDS,
  },
  {
    name: 'lcd-dark',
    themeMode: 'dark',
    themeColor: 'default',
    eink: false,
    thresholds: LCD_THRESHOLDS,
  },
];

const FOCUS_STEPS = 30;

// The Palma's portrait viewport in CSS pixels, with touch like the device.
test.use({ viewport: { width: 412, height: 824 }, hasTouch: true, deviceScaleFactor: 2 });

class Collector {
  samples: ContrastSample[] = [];
  skips: ContrastSkip[] = [];
  surfaces: { surface: string; theme: string | null; eink: string | null }[] = [];
  missed: string[] = [];

  constructor(
    private page: Page,
    private mode: Mode,
  ) {}

  async scan(surface: string, rootSelector: string | null = null) {
    const attrs = await this.page.evaluate(() => ({
      theme: document.documentElement.getAttribute('data-theme'),
      eink: document.documentElement.getAttribute('data-eink'),
    }));
    this.surfaces.push({ surface, ...attrs });
    expect(attrs.theme, `${surface}: data-theme`).toBe(
      `${this.mode.themeColor}-${this.mode.themeMode}`,
    );
    expect(attrs.eink === 'true', `${surface}: data-eink`).toBe(this.mode.eink);

    const base = { surface, mode: this.mode.name, thresholds: this.mode.thresholds };
    const rest = await scanContrast(this.page, { ...base, rootSelector, onlyActive: false });
    this.samples.push(...rest.samples);
    this.skips.push(...rest.skips);

    // Focused states: real Tab presses so :focus-visible styles apply.
    await this.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    const seen = new Set<string>();
    for (let i = 0; i < FOCUS_STEPS; i++) {
      await this.page.keyboard.press('Tab');
      // Let focus-ring and hover transitions finish before sampling colors.
      // Capped: a paused or scroll-linked animation never settles.
      await this.page.evaluate(() =>
        Promise.race([
          Promise.all(
            document
              .getAnimations()
              .filter((an) => an.effect?.getTiming().iterations !== Infinity)
              .map((an) => an.finished.catch(() => undefined)),
          ),
          new Promise((resolve) => setTimeout(resolve, 400)),
        ]),
      );
      const focused = await scanContrast(this.page, {
        ...base,
        surface: `${surface}:focus`,
        rootSelector,
        onlyActive: true,
      });
      const key = focused.samples.map((s) => s.path + s.text).join('|');
      if (!key || seen.has(key)) continue;
      seen.add(key);
      this.samples.push(...focused.samples.filter((s) => s.state.includes('focused')));
    }
    await this.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  }

  failures() {
    return this.samples.filter((s) => !s.pass);
  }

  write() {
    const out = process.env['THEME_CONTRAST_OUT'];
    if (!out) return;
    fs.mkdirSync(out, { recursive: true });
    const failures = this.failures();
    fs.writeFileSync(
      path.join(out, `${this.mode.name}.json`),
      JSON.stringify(
        {
          mode: this.mode,
          measured: this.samples.length,
          failed: failures.length,
          skipped: this.skips.length,
          surfaces: this.surfaces,
          missed: this.missed,
          failures,
          skips: this.skips,
          samples: this.samples,
        },
        null,
        2,
      ),
    );
  }
}

async function barRevealed(page: Page, selector: string) {
  return page
    .locator(selector)
    .first()
    .evaluate((bar) => {
      const style = getComputedStyle(bar);
      const r = bar.getBoundingClientRect();
      const onScreen = r.top >= -1 && r.bottom <= window.innerHeight + 1 && r.height > 0;
      return onScreen && style.pointerEvents !== 'none' && Number(style.opacity) > 0.1;
    });
}

/** Reveal an auto-hiding reader bar and wait until it takes pointer events. */
async function ensureBar(page: Page, reader: ReaderPage, which: 'header' | 'footer') {
  const selector = which === 'header' ? '.header-bar' : '.footer-bar';
  for (let i = 0; i < 4; i++) {
    if (await barRevealed(page, selector)) return;
    await (which === 'header' ? reader.revealHeader() : reader.revealFooter());
    await page.waitForTimeout(500);
  }
  expect(await barRevealed(page, selector), `${which} bar revealed`).toBe(true);
}

async function ensureHeader(page: Page, reader: ReaderPage) {
  await ensureBar(page, reader, 'header');
}

async function openSettings(page: Page, reader: ReaderPage) {
  await ensureHeader(page, reader);
  await page.locator('.header-bar button[aria-label="View Options"]').click();
  await page.locator('.view-menu').getByText('Settings', { exact: true }).click();
}

async function openBookDetails(page: Page) {
  await clickIfPresent(page, '[aria-label="Show Book Details"]');
  await page.locator('button[title="Edit Metadata"]').waitFor({ state: 'visible' });
}

async function tagFirstBook(page: Page, tag: string) {
  await openBookDetails(page);
  await page.locator('button[title="Edit Metadata"]').click();
  await page.locator('input[placeholder="Favorites, To Read"]').fill(tag);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(page.locator('button[title="Edit Metadata"]')).toBeHidden();
}

async function setEinkMode(page: Page, reader: ReaderPage, on: boolean) {
  await openSettings(page, reader);
  await page.locator('[data-tab="Control"]').click();
  const toggle = page
    .locator('[data-setting-id="settings.control.einkMode"]')
    .getByRole('checkbox')
    .first();
  if (await toggle.count()) {
    await toggle.setChecked(on);
  } else {
    const row = page.getByText('E-Ink Mode', { exact: true }).first();
    await row.scrollIntoViewIfNeeded();
    const box = row.locator('xpath=ancestor::*[.//input[@type="checkbox"]][1]');
    await box.locator('input[type="checkbox"]').first().setChecked(on);
  }
  await expect
    .poll(() => page.evaluate(() => document.documentElement.getAttribute('data-eink')))
    .toBe(String(on));
  await page.keyboard.press('Escape');
}

/**
 * Click a control if it is rendered. The reader bars slide in and out, so a
 * pointer click can land mid-transition on the page behind; a DOM click runs
 * the same React handler without the hit test.
 */
async function clickIfPresent(page: Page, selector: string) {
  const el = page.locator(selector).first();
  if (!(await el.count())) return false;
  await el.evaluate((e) => (e as HTMLElement).click());
  return true;
}

for (const mode of MODES) {
  test(`controls stay readable: ${mode.name}`, async ({ page }) => {
    test.setTimeout(600_000);
    await page.addInitScript(({ themeMode, themeColor }) => {
      try {
        localStorage.setItem('themeScheduleDefaultApplied', 'true');
        localStorage.setItem('themeMode', themeMode);
        localStorage.setItem('themeColor', themeColor);
      } catch {
        // ignore
      }
      // `next dev` floats an issues badge over the footer; it is not app UI.
      document.addEventListener('DOMContentLoaded', () => {
        const style = document.createElement('style');
        style.textContent = 'nextjs-portal { display: none !important; }';
        document.head.appendChild(style);
      });
    }, mode);

    const c = new Collector(page, mode);
    const library = new LibraryPage(page);
    await library.goto();
    await library.importBook(SAMPLE_EPUB);
    await expect(library.bookCards()).toHaveCount(1);
    // Household shelf chips appear once a book carries a shelf tag.
    await tagFirstBook(page, 'Fiction');
    await library.openFirstBook();
    const reader = new ReaderPage(page);
    await reader.waitForReady();
    await setEinkMode(page, reader, mode.eink);

    // Reader chrome.
    await ensureHeader(page, reader);
    await c.scan('reader-header', '.header-bar');
    await ensureBar(page, reader, 'footer');
    await page.waitForTimeout(400);
    await c.scan('reader-footer', '.footer-bar');
    for (const tab of ['Color', 'Reading Progress', 'Font & Layout']) {
      await ensureBar(page, reader, 'footer');
      if (await clickIfPresent(page, `.footer-bar [aria-label="${tab}"]`)) {
        await page.waitForTimeout(400);
        await c.scan(`reader-footer-${tab}`, '.footer-bar');
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);
      } else {
        c.missed.push(`reader-footer-${tab}`);
      }
    }
    await ensureHeader(page, reader);
    await page.locator('.header-bar button[aria-label="View Options"]').click();
    await page.waitForTimeout(300);
    await c.scan('reader-view-menu', '.view-menu');
    await page.keyboard.press('Escape');

    // Phones open the sidebar from the footer's contents button.
    if (await clickIfPresent(page, '.footer-bar [aria-label="Table of Contents"]')) {
      const sidebar = page.locator('[role="navigation"][aria-label="Sidebar"]');
      await sidebar.waitFor({ state: 'visible', timeout: 5_000 });
      await page.waitForTimeout(400);
      await c.scan('reader-sidebar', '[role="navigation"][aria-label="Sidebar"]');
      await page.keyboard.press('Escape');
    } else {
      c.missed.push('reader-sidebar');
    }

    // Every settings panel.
    await openSettings(page, reader);
    const tabs = await page
      .locator('[data-tab]')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-tab')!));
    for (const tab of tabs) {
      await page.locator(`[data-tab="${tab}"]`).click();
      await page.waitForTimeout(300);
      await c.scan(`settings-${tab}`, '.modal-box, [role="dialog"]');
    }
    await page.keyboard.press('Escape');

    // Library: filter chips, header, menus. A reload keeps the stored modes.
    await library.goto();
    await page.waitForTimeout(500);
    await c.scan('library');
    const headerMenus = await page
      .locator(
        '[aria-label="Library Header"] [aria-haspopup], [aria-label="Library Header"] .dropdown > [role="button"], [aria-label="Library Header"] .dropdown > button',
      )
      .all();
    for (const [i, menu] of headerMenus.entries()) {
      if (!(await menu.isVisible())) continue;
      await menu.click();
      await page.waitForTimeout(300);
      await c.scan(`library-menu-${i}`, '.dropdown-content, .menu-container');
      await page.keyboard.press('Escape');
    }
    await openBookDetails(page);
    await c.scan('library-book-details', '.modal-box, [role="dialog"]');
    await page.locator('button[title="Edit Metadata"]').click();
    await page.waitForTimeout(300);
    await c.scan('library-book-edit', '.modal-box, [role="dialog"]');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await expect(page.locator('button[title="Edit Metadata"]')).toBeHidden();
    await expect(page.locator('[data-testid="shelf-filter-bar"]')).toBeVisible();

    for (const id of ['fiction', 'all']) {
      if (await clickIfPresent(page, `[data-shelf-filter="${id}"]`)) {
        await page.waitForTimeout(200);
        await c.scan(`library-filter-${id}`, '[data-testid="shelf-filter-bar"]');
      }
    }

    // Discover (household builds only).
    if (await page.locator('[data-testid="shelf-discover"]').count()) {
      await page.goto('/discover');
      await page.getByRole('radiogroup').first().waitFor({ state: 'visible' });
      await page.waitForTimeout(500);
      await c.scan('discover');
      await page.getByRole('radio', { name: 'Ebooks' }).click();
      await c.scan('discover-ebooks', '[role="radiogroup"]');
    } else {
      c.missed.push('discover');
    }

    c.write();
    const failures = c.failures();
    expect(
      failures.map(
        (f) =>
          `${f.surface} ${f.kind} "${f.text || f.label}" [${f.state.join(',')}] ` +
          `${f.fg} on ${f.bg} = ${f.ratio} < ${f.threshold}`,
      ),
    ).toEqual([]);
  });
}
