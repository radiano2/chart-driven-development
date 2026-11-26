// Turns HTML into PNG images with a headless browser: mockups (AI-written HTML) and screenshots of the running app.
// Uses playwright-core with the Chrome or Edge already on this computer, or a browser set with CDD_CHROME.
import type { Browser } from "playwright-core";
import { HttpError } from "../project.ts";

export const NO_BROWSER_MESSAGE =
  "Couldn't start a browser to draw images. Install Google Chrome, or set CDD_CHROME to a Chrome/Chromium executable, or run `npx playwright install chromium`.";

let browser: Promise<Browser> | null = null;

async function launch(): Promise<Browser> {
  const { chromium } = await import("playwright-core");
  const attempts: (() => Promise<Browser>)[] = [];
  const explicit = process.env.CDD_CHROME;
  if (explicit) attempts.push(() => chromium.launch({ executablePath: explicit }));
  else {
    attempts.push(() => chromium.launch({ channel: "chrome" }));
    attempts.push(() => chromium.launch({ channel: "msedge" }));
    attempts.push(() => chromium.launch()); // a browser from `npx playwright install chromium`
  }
  let last: unknown;
  for (const a of attempts) {
    try {
      return await a();
    } catch (e) {
      last = e;
    }
  }
  throw new HttpError(503, `${NO_BROWSER_MESSAGE}${last ? ` (${String((last as Error).message).split("\n")[0]})` : ""}`);
}

async function getBrowser(): Promise<Browser> {
  if (!browser) {
    browser = launch();
    browser.then(
      (b) => b.on("disconnected", () => (browser = null)),
      () => (browser = null),
    );
  }
  return browser;
}

/** True when a browser can be started (used by tests to skip when there is none). */
export async function browserAvailable(): Promise<boolean> {
  try {
    await getBrowser();
    return true;
  } catch {
    return false;
  }
}

export async function closeBrowser() {
  const b = browser;
  browser = null;
  if (b) await (await b.catch(() => null))?.close().catch(() => undefined);
}

process.on("exit", () => void closeBrowser());

export interface Rendered {
  png: Buffer;
  /** Region images by data-bubble id. */
  crops: Record<string, Buffer>;
}

const VIEWPORT = { width: 1280, height: 800 };

/**
 * Render AI-written HTML. JavaScript is off and every network request is blocked, so a mockup can't load
 * anything or call out; it is only drawn.
 */
export async function renderHtml(html: string): Promise<Rendered> {
  const b = await getBrowser();
  const ctx = await b.newContext({ viewport: VIEWPORT, javaScriptEnabled: false, deviceScaleFactor: 1 });
  try {
    await ctx.route("**/*", (route) => (route.request().url().startsWith("data:") ? route.continue() : route.abort()));
    const page = await ctx.newPage();
    await page.setContent(html, { waitUntil: "load", timeout: 20_000 });
    const png = await page.screenshot({ fullPage: true, type: "png" });
    const crops: Record<string, Buffer> = {};
    for (const el of await page.$$("[data-bubble]")) {
      const id = (await el.getAttribute("data-bubble"))?.trim();
      if (!id || crops[id] || !/^[a-z0-9-]{1,80}$/.test(id)) continue;
      const box = await el.boundingBox();
      if (!box || box.width < 4 || box.height < 4) continue;
      crops[id] = await el.screenshot({ type: "png" });
    }
    return { png, crops };
  } finally {
    await ctx.close();
  }
}

/** Only the user's own computer: screenshots never open other websites. */
export function checkLocalUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new HttpError(400, `Not a web address: ${raw}`);
  }
  if (!/^https?:$/.test(u.protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)) {
    throw new HttpError(400, "Screenshots only open the app on this computer (http://localhost:…)");
  }
  const port = u.port || (u.protocol === "https:" ? "443" : "80");
  if (process.env.CDD_PORT && port === process.env.CDD_PORT) throw new HttpError(400, `${u.origin} is Chart Driven Development itself, not your app. Set the app's own address.`);
  return u;
}

/** Screenshot a page of the running app; `selector` narrows it to one part (falls back to the whole page). */
export async function screenshotUrl(url: string, selector?: string): Promise<{ png: Buffer; cropped: boolean }> {
  checkLocalUrl(url);
  const b = await getBrowser();
  const ctx = await b.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  try {
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: "networkidle", timeout: 20_000 }).catch(async (e) => {
      // networkidle can hang on apps that poll; a loaded page is good enough.
      if (!/Timeout/i.test(String(e))) throw new HttpError(502, `Couldn't open ${url}: ${String(e.message).split("\n")[0]}`);
    });
    if (selector) {
      const el = await page.$(selector).catch(() => null);
      const box = el ? await el.boundingBox() : null;
      if (el && box && box.width >= 1) {
        if (box.height >= 4) return { png: await el.screenshot({ type: "png" }), cropped: true };
        // Present but empty (e.g. a list with no items yet): show its spot on the page with a little room around it.
        await el.scrollIntoViewIfNeeded().catch(() => undefined);
        const b2 = (await el.boundingBox()) ?? box;
        const clip = { x: Math.max(0, b2.x - 8), y: Math.max(0, b2.y - 8), width: Math.max(b2.width + 16, 120), height: 60 };
        return { png: await page.screenshot({ type: "png", clip }), cropped: true };
      }
    }
    return { png: await page.screenshot({ fullPage: true, type: "png" }), cropped: false };
  } finally {
    await ctx.close();
  }
}

/** Wait until something answers at `url` (the app was just started). */
export async function waitForUrl(url: string, timeoutMs = 20_000): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(2000) });
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  return false;
}
