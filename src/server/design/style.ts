// Normalizers for what the AI returns about design (style guide, mockups), so bad output can't break the app.
import type { StyleGuide } from "../../shared/types.ts";

const text = (v: unknown, max = 400) => String(v ?? "").trim().slice(0, max);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** CSS color values only (hex, rgb/hsl/oklch functions, plain names), so they are safe to put into CSS. */
export function cleanColor(v: unknown): string | null {
  const s = text(v, 60);
  return /^(#[0-9a-f]{3,8}|(rgb|rgba|hsl|hsla|oklch|oklab|lab|lch)\([0-9a-z.,%\s/+-]+\)|[a-z]{3,20})$/i.test(s) ? s : null;
}

export function normStyle(raw: unknown): StyleGuide | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const colors = list(o.colors)
    .map((c) => {
      const r = (c && typeof c === "object" ? c : {}) as Record<string, unknown>;
      const value = cleanColor(r.value ?? r.hex);
      const name = text(r.name, 40).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
      return value && name ? { name, value, ...(r.use ? { use: text(r.use, 120) } : {}) } : null;
    })
    .filter((c): c is NonNullable<typeof c> => !!c)
    .slice(0, 12);
  const fonts = list(o.fonts)
    .map((f) => {
      const r = (f && typeof f === "object" ? f : {}) as Record<string, unknown>;
      const family = text(r.family, 160).replace(/[;{}<>]/g, "");
      return family ? { role: text(r.role, 40) || "body", family } : null;
    })
    .filter((f): f is NonNullable<typeof f> => !!f)
    .slice(0, 4);
  const style: StyleGuide = {
    summary: text(o.summary, 600),
    colors,
    fonts,
    radius: text(o.radius, 80),
    spacing: text(o.spacing, 160),
    mood: list(o.mood).map((m) => text(m, 40)).filter(Boolean).slice(0, 6),
    rules: list(o.rules).map((m) => text(m, 200)).filter(Boolean).slice(0, 8),
  };
  return style.summary || style.colors.length ? style : null;
}

/** The same style guide as CSS variables, for the UI's swatches and for prompts. */
export function styleCss(s: StyleGuide): string {
  return `:root {\n${s.colors.map((c) => `  --${c.name}: ${c.value};`).join("\n")}\n}`;
}
