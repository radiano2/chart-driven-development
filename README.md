# Chart Driven Development

Build an app by drawing and growing a flowchart. You describe an idea, the AI suggests a tech stack, draws your app as a chart of **modules**, and writes **real code** into a normal project folder. Open a module to see its **function bubbles**. Select any bubble and ask the AI to keep building from there.

![bubbles are functions, arrows are data + call order](docs/chart.png)

## Quick start

```bash
npm install
npm start                   # http://localhost:4317
```

Then click **⚙ Settings** (top right), paste your DeepSeek API key and press **Save**. It's checked against DeepSeek right away and takes effect without a restart.
The key is stored only on this computer in `.cdd/settings.json` (git-ignored, readable only by you) and is never sent back to the browser.
`DEEPSEEK_API_KEY` in `.env` still works too; a key saved in Settings takes priority. From a terminal: `npm run cdd -- set-key` (typed hidden). Only a key DeepSeek rejects (401) is refused; if the account has no balance or DeepSeek can't be reached, the key is saved with a warning.

No API key yet? `npm run start:mock` runs the whole flow offline with a canned "todo app" so you can click around.

Requires Node 20+ and git.

## How it works

| You do | What happens |
| --- | --- |
| Type an idea ("todo app") | The AI recommends a tech stack plus alternatives. You pick one. |
| Pick a stack | The AI draws the module chart, then writes scaffolding and each module's code. Every step is a git commit in the generated project. |
| Click a bubble | See its description, inputs, outputs, file and code. |
| Double-click a module | Open its inner chart of functions. Dashed bubbles are functions in other modules; click one to jump there. |
| Select a bubble, type what should happen next | The AI first **recommends how to proceed** (extend / split / rewrite / rewire). Pick an option and it updates the chart and code right away. |
| **＋ Bubble** | Draw a bubble by hand (name, description, optional inputs/outputs). It's a draft until you click **Write the code**. |
| **Draw arrow from here** | Connect two bubbles by hand and name the data that flows. |
| **▶ Run** | The AI invents abstract test data and the chart animates it flowing through the bubbles in call order. |
| **Undo** / **History** | Restore any earlier version (code and chart together). Restores are new commits, so they can be undone too. |
| Edit code in your own editor | The app notices uncommitted changes and offers to read them and update the chart, or keep them without updating. |

Arrows show **both** call order (the number) and the **shape of the data** passed.

## Assistant and the `cdd` command line

The **✦ Assistant** button opens a chat with DeepSeek that can work on the open project with tools. If a bubble is selected, the assistant is told which one.
What it knows about the app is in [`skills/cdd-assistant.md`](skills/cdd-assistant.md). Edit that file to change how it behaves.

It can:
- read the chart and the code, list and search files
- write or delete files and update the chart (kept in sync, per the guide)
- list versions, undo, restore a version
- run a short allowlist of commands directly (`npm install`, `npm test`, `npm run build`, …)
- start / stop the generated app in the background and read its output (starting always asks you)
- open the project folder in your file manager

It can't reach anything outside the project folder (paths are normalised and symlinks resolved first), and it can't touch `.git` (at any depth, any letter case) or `.chart`.
**Any command that isn't on the allowlist asks you first** ("Allow once" / "Don't allow"). If no tab has the project open, or you press **Stop**, it is refused.
Be aware the allowlist is not a sandbox: `npm install` / `npm test` / `npm run build` run the project's own scripts, which the assistant can edit. Each run is visible in the chat and every change can be undone.
Everything one message changes is saved as one version, so a bad answer is one **Undo** away.

The same assistant runs headless in a terminal, with no browser or server needed:

```bash
npm run cdd -- projects
npm run cdd -- chart todo-app todos
npm run cdd -- ask todo-app "add a priority to todos and show it in the list"
npm run cdd -- chat todo-app          # conversation; type exit to quit
npm run cdd -- sync todo-app          # outside edits → update the chart (or: keep)
npm run cdd -- versions todo-app
npm run cdd -- undo todo-app
npm run cdd -- folder todo-app --open
```

`npm link` installs it as a plain `cdd` command. In a terminal it asks before running commands that aren't on the allowlist. When it's not interactive (scripts, background jobs) it refuses them.
Avoid running the CLI and the web app on the **same** project at the same moment; each saves its own versions.

## Design: style guide, mockups, screenshots

The **Design** button opens the project's look:

- **Style guide**: colors, fonts, corners, spacing and a few rules. Every mockup and UI change follows it.
- **Reference images**: drop, paste or pick an image of a look you like (PNG, JPEG, WebP or GIF, up to 8 MB), with an optional note such as "the colors". DeepSeek (`deepseek-flash`, which reads images) describes it and updates the style guide.
- **Mockups**: describe a design ("a dark theme with a teal accent"). The AI writes it as one HTML page, which the app draws to a PNG with a headless browser. JavaScript and the network are off while it's drawn. **Apply to the code** restyles the app to match, and a mockup's new style becomes the project's style guide. Saved as a version, so it can be undone.
- **Screenshots on UI bubbles**: bubbles that draw UI say **UI** on the chart. Click one to see its part of the running app (**Take screenshot** starts the app with its run command if it isn't running) and its part of recent mockups. Mark any bubble as UI, and set the page path and CSS selector, under **Where it shows**.

DeepSeek can't draw images, so mockups are HTML that the app renders. That keeps them true to real fonts and layout, and they can turn straight into code.
Drawing needs Chrome or Edge on the computer (or set `CDD_CHROME` to a Chrome/Chromium executable, or run `npx playwright install chromium`).
How the AI should design (formats, mockup rules, answer layout) is in [`skills/cdd-design.md`](skills/cdd-design.md). The assistant follows it too, and has `get_design`, `update_style`, `create_mockup` and `take_screenshot` tools.

Design files live in the project under `.chart/design/` and are versioned with the code, except screenshots, which are re-taken from the running app.

## Where things live

- Generated projects: `./projects/<name>/` (change with `CDD_WORKSPACE`). Each one is a normal folder with its own git repo.
- The chart is stored next to the code in `.chart/chart.json`, so it is versioned together with the code.
- The app binds to `127.0.0.1` only. Single user, no accounts. The API only accepts JSON requests from the app's own page, so other websites you visit can't call it (CSRF / DNS-rebinding protection).

## Code layout

```
src/shared/      types + chart helpers used by server and browser
src/server/      local HTTP API, project/git/watch logic
src/server/ai/   AI interface, DeepSeek client + prompts (llm.ts), offline mock (mock.ts)
src/server/agent/ assistant loop, tools + safety rules, web approvals (hub.ts)
src/server/design/ style guide, references, mockups (render.ts draws HTML to PNG), screenshots
src/cli/         the `cdd` command line
skills/          the AI's guides: cdd-assistant.md (the app), cdd-design.md (design work)
src/client/      browser UI: chart rendering (dagre + SVG), panels, run animation
public/          index.html, styles.css (client bundle builds to public/build)
test/            end-to-end todo demo, LLM output normalization, assistant tools + CLI, design
```

`npm test` runs the tests, `npm run typecheck` type-checks everything.

## Assumptions made for this first version

These weren't specified, so I picked something reasonable. Easy to change.

- **Outside edits** are detected by polling `git status` every 1.5 s while the project is open (the app commits everything it does itself, so anything uncommitted came from outside). This survives editors and git replacing files, which recursive file watching didn't.
- **"Keep, don't update"** on outside edits commits them as-is so the warning goes away.
- The **assistant won't start a turn while there are outside edits** you haven't decided about; it asks you to choose "Update the chart" or "Keep, don't update" first (`cdd sync` / `cdd keep` in a terminal). Otherwise your edits would end up inside the assistant's version.
- The assistant reads long files in ~48 KB parts and drops old tool output when the conversation gets too long, so it stays within DeepSeek's context window.
- **Run** works at the level you're looking at (modules, or a module's functions). It doesn't execute your code.
- **Arrows into other modules** are written as `module-id/function-id` and drawn as dashed "ghost" bubbles.
- **Removing a bubble** removes it from the chart only; its code stays (ask the AI to rewrite if you want code removed).
- The AI always returns **whole files**, not diffs, which is simpler and more reliable with DeepSeek's JSON mode. Very large files may hit the response limit; you'll see a clear error if so.
- Generation makes one AI call for the chart, one for scaffolding and one per module.
- Layout picks left-to-right or top-to-bottom, whichever fits your screen better.
