import type { Page } from '@playwright/test';

/**
 * Text-vs-background contrast scan for interactive controls.
 *
 * Reads the colors the browser actually paints (computed styles after the
 * whole cascade, e-ink overrides included), normalizes every color through a
 * 1x1 canvas so oklch/color-mix/alpha values come back as sRGB bytes, and
 * composites translucent backgrounds and ancestor opacity over the nearest
 * opaque surface before taking the WCAG contrast ratio.
 *
 * WCAG relative luminance is also the grey level a monochrome e-ink panel
 * shows, so a colored accent is measured as the grey it becomes there.
 */

export type ContrastKind = 'text' | 'icon' | 'control';

export interface ContrastSample {
  surface: string;
  mode: string;
  kind: ContrastKind;
  role: string;
  label: string;
  text: string;
  state: string[];
  fg: string;
  bg: string;
  ratio: number;
  threshold: number;
  pass: boolean;
  path: string;
  /** Class attributes of the control and the measured element, for triage. */
  classes: string;
}

export interface ContrastSkip {
  surface: string;
  mode: string;
  label: string;
  reason: string;
  path: string;
}

export interface Thresholds {
  /** Enabled text (labels, counts). */
  text: number;
  /** Icon-only glyphs and muted (translucent) text. */
  secondary: number;
  /** Disabled controls. WCAG 1.4.3 exempts inactive components; e-ink still
      holds them to a floor because a greyed label dithers away on the panel. */
  disabled: number;
  /** Non-text control parts: toggle and checkbox fill or border. */
  control: number;
}

/** Monochrome e-ink panel: text at AAA, the rest at AA. */
export const EINK_THRESHOLDS: Thresholds = { text: 7, secondary: 4.5, disabled: 4.5, control: 3 };
/** LCD: WCAG AA text, non-text 3:1. */
export const LCD_THRESHOLDS: Thresholds = { text: 4.5, secondary: 3, disabled: 1, control: 3 };

interface ScanArgs {
  surface: string;
  mode: string;
  rootSelector: string | null;
  thresholds: Thresholds;
  onlyActive: boolean;
}

/**
 * Measure every visible control under `rootSelector` (the whole document when
 * null). With `onlyActive`, measure just `document.activeElement`'s control,
 * which is how focused states are scanned after a real Tab key press.
 */
export async function scanContrast(
  page: Page,
  args: ScanArgs,
): Promise<{ samples: ContrastSample[]; skips: ContrastSkip[] }> {
  return page.evaluate((a: ScanArgs) => {
    const CONTROL_SELECTOR = [
      'button',
      'a[href]',
      'select',
      'input[type="checkbox"]',
      'input[type="radio"]',
      '[role="button"]',
      '[role="radio"]',
      '[role="tab"]',
      '[role="switch"]',
      '[role="checkbox"]',
      '[role="menuitem"]',
      '[role="menuitemradio"]',
      '[role="menuitemcheckbox"]',
      '[role="option"]',
      '.badge',
    ].join(',');

    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    type RGBA = [number, number, number, number];
    const cache = new Map<string, RGBA>();
    const toRGBA = (css: string): RGBA => {
      const hit = cache.get(css);
      if (hit) return hit;
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = '#000';
      ctx.fillStyle = css;
      ctx.fillRect(0, 0, 1, 1);
      const d = ctx.getImageData(0, 0, 1, 1).data;
      const v: RGBA = [d[0]!, d[1]!, d[2]!, d[3]! / 255];
      cache.set(css, v);
      return v;
    };
    const over = (top: RGBA, alpha: number, under: RGBA): RGBA => [
      top[0] * alpha + under[0] * (1 - alpha),
      top[1] * alpha + under[1] * (1 - alpha),
      top[2] * alpha + under[2] * (1 - alpha),
      1,
    ];
    const lum = (c: RGBA) => {
      const ch = (v: number) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * ch(c[0]) + 0.7152 * ch(c[1]) + 0.0722 * ch(c[2]);
    };
    const ratio = (x: RGBA, y: RGBA) => {
      const [l1, l2] = [lum(x), lum(y)].sort((m, n) => n - m) as [number, number];
      return (l1 + 0.05) / (l2 + 0.05);
    };
    const hex = (c: RGBA) =>
      '#' + [c[0], c[1], c[2]].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

    const pathOf = (el: Element) => {
      const parts: string[] = [];
      let n: Element | null = el;
      while (n && n !== document.body && parts.length < 5) {
        let s = n.tagName.toLowerCase();
        const id = n.getAttribute('data-testid') || n.getAttribute('aria-label');
        if (id) s += `[${id.slice(0, 40)}]`;
        parts.unshift(s);
        n = n.parentElement;
      }
      return parts.join(' > ');
    };

    const classesOf = (c: Element, target: Element) => {
      const cc = c.getAttribute('class') || '';
      const tc = target === c ? '' : target.getAttribute('class') || '';
      return tc ? `${cc} || ${tc}` : cc;
    };

    const opacityChain = (el: Element) => {
      let o = 1;
      for (let n: Element | null = el; n; n = n.parentElement) {
        o *= Number(getComputedStyle(n).opacity);
      }
      return o;
    };

    /** Background painted behind `el`: composite ancestors top-down. */
    const backgroundOf = (el: Element): { color: RGBA; image: Element | null } => {
      const chain: Element[] = [];
      for (let n: Element | null = el; n; n = n.parentElement) chain.push(n);
      let start = chain.length - 1;
      let image: Element | null = null;
      for (let i = 0; i < chain.length; i++) {
        const cs = getComputedStyle(chain[i]!);
        if (cs.backgroundImage !== 'none' && !image) image = chain[i]!;
        const c = toRGBA(cs.backgroundColor);
        if (c[3] * opacityChain(chain[i]!) >= 0.999) {
          start = i;
          break;
        }
      }
      let color: RGBA = [255, 255, 255, 1];
      for (let i = start; i >= 0; i--) {
        const n = chain[i]!;
        const c = toRGBA(getComputedStyle(n).backgroundColor);
        const alpha = c[3] * (i === start ? 1 : opacityChain(n) / opacityChain(chain[start]!));
        if (alpha > 0) color = over(c, Math.min(1, alpha), color);
      }
      return { color, image };
    };

    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      if (r.width <= 1 || r.height <= 1) return false;
      if (!el.checkVisibility({ visibilityProperty: true } as CheckVisibilityOptions)) return false;
      // Auto-hidden chrome keeps its box at opacity 0; it is not on screen.
      return opacityChain(el) > 0.05;
    };

    const stateOf = (el: Element) => {
      const s: string[] = [];
      for (const attr of ['aria-checked', 'aria-selected', 'aria-pressed', 'aria-current']) {
        const v = el.getAttribute(attr);
        if (v && v !== 'false') s.push(`${attr.slice(5)}`);
      }
      if (el.getAttribute('aria-expanded') === 'true') s.push('expanded');
      const cls = el.getAttribute('class') || '';
      if (/\b(btn-active|tab-active|active)\b/.test(cls)) s.push('active');
      if ((el as HTMLInputElement).checked) s.push('checked');
      if (
        (el as HTMLButtonElement).disabled ||
        el.getAttribute('aria-disabled') === 'true' ||
        /\b(btn-disabled|select-disabled)\b/.test(cls) ||
        el.closest('fieldset:disabled')
      ) {
        s.push('disabled');
      }
      if (el === document.activeElement || el.contains(document.activeElement)) {
        if (el.matches(':focus-visible') || el.querySelector(':focus-visible')) s.push('focused');
      }
      if (opacityChain(el) < 0.999) s.push('muted');
      return s;
    };

    const root = a.rootSelector ? document.querySelector(a.rootSelector) : document.body;
    const samples: ContrastSample[] = [];
    const skips: ContrastSkip[] = [];
    if (!root) return { samples, skips };

    let controls: Element[];
    if (a.onlyActive) {
      const act = document.activeElement;
      const ctl = act?.closest(CONTROL_SELECTOR);
      controls = ctl && ctl !== document.body && root.contains(ctl) ? [ctl] : [];
    } else {
      controls = Array.from(root.querySelectorAll(CONTROL_SELECTOR));
    }
    // A control nested in another (a badge inside a chip) is measured through
    // its outer control's text walk; keep only outermost controls.
    controls = controls.filter(
      (c) => !controls.some((o) => o !== c && o.contains(c)) && visible(c),
    );

    const push = (
      c: Element,
      kind: ContrastKind,
      target: Element,
      fg: RGBA,
      text: string,
      state: string[],
    ) => {
      const bg = backgroundOf(target);
      const label =
        c.getAttribute('aria-label') || c.getAttribute('title') || (c.textContent || '').trim();
      if (bg.image && bg.image !== document.documentElement && bg.image !== document.body) {
        skips.push({
          surface: a.surface,
          mode: a.mode,
          label: label.slice(0, 60),
          reason: `background-image on ${pathOf(bg.image)}`,
          path: pathOf(target),
        });
        return;
      }
      const alpha = fg[3] * opacityChain(target);
      const painted = over(fg, alpha, bg.color);
      const r = ratio(painted, bg.color);
      const threshold = state.includes('disabled')
        ? Math.min(a.thresholds.disabled, kind === 'control' ? a.thresholds.control : Infinity)
        : kind === 'control'
          ? a.thresholds.control
          : kind === 'icon' || state.includes('muted')
            ? a.thresholds.secondary
            : a.thresholds.text;
      samples.push({
        surface: a.surface,
        mode: a.mode,
        kind,
        role: c.getAttribute('role') || c.tagName.toLowerCase(),
        label: label.slice(0, 60),
        text: text.slice(0, 40),
        state,
        fg: hex(painted),
        bg: hex(bg.color),
        ratio: Math.round(r * 100) / 100,
        threshold,
        pass: r >= threshold,
        path: pathOf(target),
        classes: classesOf(c, target),
      });
    };

    for (const c of controls) {
      const state = stateOf(c);

      if (c instanceof HTMLInputElement && (c.type === 'checkbox' || c.type === 'radio')) {
        // Non-text: the box or track must stand out from the surface it sits on.
        const cs = getComputedStyle(c);
        const outer = backgroundOf(c.parentElement || c).color;
        const border = toRGBA(cs.borderTopColor);
        const fill = toRGBA(cs.backgroundColor);
        const bRatio = border[3] > 0 ? ratio(over(border, border[3], outer), outer) : 1;
        const fRatio = fill[3] > 0 ? ratio(over(fill, fill[3], outer), outer) : 1;
        const best = bRatio >= fRatio ? border : fill;
        const r = Math.max(bRatio, fRatio);
        const controlFloor = state.includes('disabled')
          ? Math.min(a.thresholds.disabled, a.thresholds.control)
          : a.thresholds.control;
        samples.push({
          surface: a.surface,
          mode: a.mode,
          kind: 'control',
          role: c.className.includes('toggle') ? 'toggle' : c.type,
          label: (
            c.getAttribute('aria-label') ||
            c.closest('label, [data-setting-id]')?.textContent ||
            ''
          )
            .trim()
            .slice(0, 60),
          text: '',
          state,
          fg: hex(over(best, best[3], outer)),
          bg: hex(outer),
          ratio: Math.round(r * 100) / 100,
          threshold: controlFloor,
          pass: r >= controlFloor,
          path: pathOf(c),
          classes: classesOf(c, c),
        });
        continue;
      }

      const textOwners = new Map<Element, string>();
      const walker = document.createTreeWalker(c, NodeFilter.SHOW_TEXT);
      for (let t = walker.nextNode(); t; t = walker.nextNode()) {
        const s = (t.textContent || '').trim();
        const owner = t.parentElement;
        if (!s || !owner || !visible(owner)) continue;
        textOwners.set(owner, (textOwners.get(owner) || '') + s);
      }
      if (c instanceof HTMLSelectElement && visible(c)) {
        textOwners.set(c, c.selectedOptions[0]?.textContent?.trim() || '');
      }
      for (const [owner, text] of textOwners) {
        push(c, 'text', owner, toRGBA(getComputedStyle(owner).color), text, state);
      }
      if (textOwners.size > 0) continue;

      const svg = Array.from(c.querySelectorAll('svg')).find(visible);
      if (!svg) continue;
      // react-icons paint with currentColor through fill or stroke.
      const cs = getComputedStyle(svg);
      const shape = svg.querySelector('path, circle, rect, polyline, line, polygon');
      const shapeCs = shape ? getComputedStyle(shape) : cs;
      const pick = [shapeCs.fill, shapeCs.stroke, cs.fill, cs.stroke].find(
        (v) => v && v !== 'none' && !v.startsWith('url(') && toRGBA(v)[3] > 0,
      );
      push(c, 'icon', svg, toRGBA(pick || cs.color), '', state);
    }
    return { samples, skips };
  }, args);
}
