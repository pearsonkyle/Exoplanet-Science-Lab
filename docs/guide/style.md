# Style guide: interface and figures

The standards the site is built to, written down so that new pages and figures match the old ones. Each rule
names what checks it. Where a page does not yet meet a rule, the last section says so.

Two tools check the layout rules, both with the dev server running:

```bash
ESL_BASE=http://localhost:5173 .venv/bin/python test/layout_check.py   # pass / fail, 91 checks
node tools/uiaudit.mjs /tmp/ui                                         # screenshots and a report, 11 sizes
```

`tools/uiaudit.mjs` writes one PNG per page, state and size and a `report.json`. Its `overflow`, `off`, `covered`
and `zoom` counts must be zero for a new page. Its `narrow`, `small` and `empty` counts are leads to look at, not
failures: a label that wraps its field, a subscript, or a table that is mostly a canvas are counted too.

## Screens

The site is used on a phone at the telescope, on a tablet, and on a desk. A page is done when it works at all of:

| Size | Viewport (CSS px) | What it stands for |
|---|---|---|
| `phone-small` | 360 × 640 | a small Android phone |
| `iphone-se` | 375 × 667 | the narrowest iPhone in use |
| `iphone` | 393 × 852 | iPhone 15 / 16 |
| `iphone-max` | 430 × 932 | large phones |
| `iphone-land` | 852 × 393 | a phone on its side: very little height |
| `ipad` | 820 × 1180 | a tablet upright |
| `ipad-land` | 1180 × 820 | a tablet on its side |
| `laptop-small` | 1024 × 768 | a small window |
| `laptop` | 1366 × 768 | the common laptop |
| `desktop` | 1920 × 1080 | |
| `desktop-wide` | 2560 × 1440 | |

Rules:

1. **No sideways scroll of the page.** A wide table or a row of tabs scrolls inside its own box, and fades at the
   side that has more (`.subnav.more-r`).
2. **One column under 980 px** on the tool pages; cards may flow in two columns between 640 and 980 px. Do not
   leave a full-width field 700 px wide.
3. **Height matters as much as width.** A phone on its side has about 260 px under the bars. Write a
   `(max-height: 560px) and (orientation: landscape)` rule for any page that fills the window (the analyzer puts
   its three parts side by side there).
4. **Use `dvh`, with `vh` before it as the fallback**, for anything sized to the window: `height: 100vh; height:
   100dvh`. Add `env(safe-area-inset-*)` to paddings at the edges of the screen.
5. **Nothing floats over a control or a figure.** The assistant's button is in the site bar (an icon on a wide
   bar, a row of the folded menu on a phone), not over the corner of the page. A status belongs in the page
   (`.status`). The two exceptions are short-lived and say so: the "Calculating" tag (it takes no taps) and the
   notice of a background job (`src/site/jobs.js`, gone 12 s after the job ends). The audit's `covered` count
   lists anything else.
6. **Empty states take little room.** A plot that has nothing to show yet is a caption, not a dark box
   (`.r-main.idle` on the Run page). An empty `.status` line holds no room.

## Touch

Applies under `@media (pointer: coarse)`, and under 760 px whatever the pointer.

- Every control is at least **40 × 40 px**. A checkbox counts by its label.
- Text in a field, a menu or a text area is **16 px**: iOS Safari zooms the whole page when a smaller one takes
  focus, and does not zoom back.
- `html { -webkit-text-size-adjust: 100% }` stays (in `site.css`): without it Safari enlarges some text on a
  phone held sideways and rows stop lining up.
- No text under 11 px anywhere; section titles are 12 px on a phone.
- Nothing depends on hover. A `title` is an extra; `src/site/tips.js` shows it on tap.

## Forms

- **A label sits over its field**, in a column: `<label>Name <input></label>` inside `.grid2`, or directly in a
  side card. Two fields share a row with `.grid2`, three with `.row3`. Label and field side by side is for sliders
  only (`.sl`: name, range, number).
- **Every `<input>` has a `type`.** The site styles untyped ones too, but the type gives a phone the right
  keyboard (`number`, `search`, `datetime-local`).
- **Numbers** are in the monospace face, right-aligned in tables, with `font-variant-numeric: tabular-nums`. A
  number is never broken across lines (`white-space: nowrap`); the table scrolls instead.
- **Units** go in the label in round brackets: `Mass (M Jup)`, `Top (bar)`.
- **Buttons**: `.btn` for an action, `.btn.primary` for the one action a card is for (one per card), `.btn.sm` in
  tool bars. A button says what it does: "Save figure (PNG)", not "Export".
- **Section titles** are `<h2>`: 11 px, upper case, letter-spaced, `var(--dim)`.
- **Wording**: sentence case, no exclamation marks, plain verbs. Say what a number is and where it comes from. If
  something was not computed or not checked, the page says so in the place the reader would expect the result.

## Colour and themes

All colour comes from the tokens in `src/site/site.css` (`--bg`, `--panel`, `--line2`, `--text`, `--dim`,
`--model`, `--star`, `--data`, `--ok`, `--warn`, `--bad`, `--post`). There are four themes (Dark, Light, Dusk,
Night); a literal colour in a stylesheet breaks three of them. Meaning is fixed:

| Token | Used for |
|---|---|
| `--model` | the model, links, the primary action |
| `--data` | measurements |
| `--star` | the star, sliders that move the system |
| `--post` | posteriors and anything sampled |
| `--ok` / `--warn` / `--bad` | a check passed / needs a look / failed |

Colour never carries meaning alone: a failed check also has a word or a mark.

## Figures

A figure is a **pure function** `render(ctx, W, H, data, theme, options)` with no DOM in it. The screen, the saved
file and the movie call the same function with different themes, so they cannot drift apart. Helpers shared by
all figures are in `src/ui/figstyle.js`.

### A saved figure stands on its own

Someone who sees only the PNG, in a paper or a talk, can read it. That means:

1. **A title naming the object and the data**: "HAT-P-32 b — TESS sector 21", "HD 209458: spectral energy
   distribution fit". Not "Light curve".
2. **Both axes labelled as "Quantity (unit)"**, sentence case, the unit in round brackets and in its usual
   symbol: `Wavelength (µm)`, `Transit depth (ppm)`, `Relative flux`, `Time from mid-transit (hours)`,
   `Pressure (bar)`. Pass labels through `axisLabel()`, which turns `micron` into `µm` and `[unit]` into `(unit)`.
   A time axis names its zero and its time scale: `BJD_TDB − 2459000`.
3. **A legend for everything drawn**: each series, and each mark that is not a series (binned points, a shaded
   band and what it holds, faint points that were left out of a fit).
4. **Error bars on measurements**, and a residual panel under any figure that shows a model over data, labelled
   with its unit (`Residuals (ppm)`, or σ).
5. **The numbers a reader checks first** in a corner of the plot: number of points and rms for a light curve.
6. **Powers of ten** drawn with `drawPow10()`; no `1e-11`, no `F_lambda`, no unit written as a word.
7. **No interface in the picture**: no cursor, hover line, tool strip or button.

### Posteriors (corner plots)

One function draws every corner plot, `drawCorner` in `src/ui/corner.js`.

- **Regions on the viridis scale, as in EXOTIC's posterior plots**: 1σ dark violet in the middle, 2σ green, 3σ
  yellow outside, the same three colours in the scatter and in the histograms. Three hues, not three tints of one.
  With stored likelihoods the points take the continuous scale instead (dark = best) and the legend shows its bar.
- **Contour lines are in the ink colour, not the points' colours**, and differ in stroke: 1σ heavy, 2σ thin,
  3σ dashed. They read without colour.
- **A hard limit is drawn as one**: where samples pile up against a prior's edge or a physical bound, the axis ends
  at the limit, the density is mirrored in it before smoothing, and the regions close along it.
- Above each histogram: the name with its unit, then median +upper −lower (16th to 84th percentile).
- The Night theme keeps to red and amber on screen; saved figures use the white theme whatever the screen shows.

### How it is saved

- **White background, dark ink** by default: the print theme (`LC_THEMES.light`, `PRINT_THEME`, `PHOT_PRINT`,
  `drawCorner(..., { theme: 'light' })`). Never save the screen canvas: it is in the reader's theme.
  A dark version may be offered beside it, for slides.
- **At least 1800 px wide** (`EXPORT_SCALE = 2` on a 900 px figure: 6 inches at 300 dpi). The analyzer also
  writes vector-quality PDF through `canvasToPDF`.
- **Colours that survive print and colour blindness**: series differ in more than hue where it matters (line
  against points, solid against dashed); the model is one colour across the site.
- **File name**: `<object>_<what>[_dark].<ext>`, lower-case what, no spaces: `HAT_P_32_b_lightcurve.png`,
  `HD_209458_sed_corner.png`.
- **The numbers go out with the picture.** Every page that saves a figure also saves what is plotted as CSV, and
  the result with its settings as JSON, so a figure can be redrawn in the journal's own style. Tables for a paper
  come from `latexTable()`; the methods paragraph and BibTeX from the Methods page.

### Where each page saves

| Page | Figure | Button |
|---|---|---|
| Analyze | light curve, radial velocities, phase curve, corner plot | Save figure ▾ (PNG or PDF, white or dark) |
| Photometry | light curve with residuals | Save figure (PNG) |
| Spectroscopy | spectrum, white light curve | PNG |
| Atmosphere | model spectrum; everything else in "Download everything" with `figures.py` | Save figure |
| Retrieval | spectra with the fit, corner plot | Save figure, Save corner plot |
| Star | spectral energy distribution, corner plot | Save figure, Save corner plot |

## Adding a page: checklist

- [ ] `<meta name="viewport" content="width=device-width, initial-scale=1">`, `<meta name="esl-root">`, the site
      bar; an entry in `vite.config.js`, in `PAGES` of `test/layout_check.py` and of `tools/uiaudit.mjs`.
- [ ] Colours from tokens only; looked at in all four themes.
- [ ] `node tools/uiaudit.mjs` at all sizes: `overflow`, `off`, `covered`, `zoom` are zero; the screenshots at
      `iphone`, `iphone-land`, `ipad` and `laptop` were looked at by a person.
- [ ] `test/layout_check.py` passes.
- [ ] Each figure is a pure render function, has a print theme, and its saved file meets "A saved figure stands
      on its own".
- [ ] Whatever is plotted can be saved as CSV.

## Not yet to this standard

- The Plan page's altitude charts and the Photometry page's diagnostic plots (centroid, sky, width) cannot be
  saved as figures; the light curve can.
- The Atmosphere page saves only the spectrum as a PNG; its other figures leave through the zip and `figures.py`.
- The tool pages' figures use an 11 px monospace face, the analyzer's a sans-serif at 1.35 times the size: both
  are legible in print, but they are not one family.
- Layout is checked in Chromium emulating a phone. iOS Safari itself (the address bar's changing height, the
  home indicator, zoom on focus) is not exercised by any test here.
