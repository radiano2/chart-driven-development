# Chart Driven Development design guide

This guide is for the **design work** in CDD: the project's style guide, reference images, mockups, and screenshots of
bubbles that show UI. It is loaded into every design prompt and into the assistant, so all design answers look the same.
Edit this file to change how the AI designs.

## The pieces

- **Style guide** (`style`): the single source of truth for how the app looks. Every mockup and every UI code change
  follows it. Shape:

  ```json
  {
    "summary": "one or two sentences: the overall look and feel",
    "colors": [ { "name": "background", "value": "#f7f7fb", "use": "page background" } ],
    "fonts": [ { "role": "body", "family": "Inter, system-ui, sans-serif" } ],
    "radius": "10px",
    "spacing": "8px grid; 16px inside cards, 24px between sections",
    "mood": ["calm", "friendly"],
    "rules": ["One primary action per screen, in the accent color."]
  }
  ```

  Colors: 4 to 8 entries, hex values, always including `background`, `surface`, `text`, `muted` and `accent`
  (add `danger`, `success`, `border` when used). Fonts: `body` and `heading` at least, with system fallbacks.
  Rules: 3 to 6 short, checkable sentences. No more than that.

- **Reference images**: pictures the user uploads to show a look they like. Describe what you see in concrete,
  reusable terms (palette with hex values, type, density, corner radius, shadows, layout pattern), not the
  subject of the picture. A reference changes the style guide only in the ways the user's note asks; if there is
  no note, take its palette, type and shape language.

- **Mockups**: a picture of a screen, made by writing one HTML page that the app renders to PNG at 1280 px wide.
- **Screenshots**: real captures of the running app, one per UI bubble (`gui` set on the bubble).

## Mockup HTML rules

1. **One self-contained file.** All CSS in a `<style>` tag. No `<script>`, no external URLs (fonts, images, CDNs):
   the renderer blocks the network and JavaScript. Use system font stacks, inline SVG for icons, CSS gradients or
   flat shapes for imagery.
2. **Use the style guide.** Declare every style guide color as a CSS variable on `:root`
   (`--background`, `--surface`, `--text`, `--muted`, `--accent`, …) and only use those variables for color.
3. **Real content.** Use believable content from the project's idea (real todo titles, real names), never lorem ipsum.
4. **Map regions to bubbles.** Put `data-bubble="<bubble-id>"` on the element each UI bubble draws, using ids from
   the chart. The app crops each of these regions and shows it when that bubble is clicked.
5. **Desktop first, 1280 × 800.** Content can be taller; the whole page is captured. Keep it to one screen of the app
   unless the request asks for more (then stack screens vertically with a small label above each).
6. **Accessible by default.** Text contrast at least 4.5:1, visible focus styles, tap targets at least 40 px.

## Answer format for a mockup request

Return one JSON object (the assistant passes the same fields to `create_mockup` instead of replying with JSON):

```json
{
  "title": "3 to 6 words naming the design, e.g. \"Dark, dense todo list\"",
  "summary": "2 or 3 sentences: what this design changes compared with the current style and why",
  "bubbleIds": ["render-todos", "on-submit"],
  "style": { "...": "the full style guide this mockup uses; omit when it uses the current one unchanged" },
  "html": "<!doctype html>…"
}
```

- `bubbleIds` lists every bubble with a `data-bubble` region in the HTML.
- If the user asked for a new look, return the new `style`. It becomes the project's style guide when the user
  applies the mockup, so several looks can be tried side by side first.
- If the user asked for a screen or part, keep the current style and leave `style` out.

## Applying a mockup or style to the code

- Change only presentation: CSS, markup structure, class names, and copy that the mockup changes. Keep behaviour,
  ids that scripts use, and every function the chart names.
- Put the style guide colors into the app as CSS variables in one place (the main stylesheet or the page's `<style>`).
- Keep or add `data-bubble="<bubble-id>"` on the root element of each UI bubble, so screenshots can find it.
- Return the usual change set: `summary`, `ops` (only if bubbles change, e.g. a new UI part), and whole `files`.

## Assistant replies about design

When the user asks the assistant about design, answer in this order, briefly:
1. **What it looks like now** in one sentence (from `get_design`).
2. **What you propose** in 2 or 3 bullet points.
3. **What you made**: the mockup title (use `create_mockup`) or the files you changed.
4. **Next step** in one question, e.g. "Apply this mockup to the code?"

Never apply a new design to the code without the user asking for it; make a mockup first.
