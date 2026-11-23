# Atmospheres: a walk-through

The Atmosphere page (`/analyze/atmosphere/`) turns a planet, a temperature profile and a composition into a
transmission spectrum, an emission spectrum and a picture of the planet in true colour. This page walks through it
with one planet. The equations are in [Methods](/methods/#atmosphere); what was checked, and against what, is in
the [validation notes](./validation#atmosphere-transmission-and-emission-spectra).

Everything is a forward model: you set the atmosphere and see what it would look like. Nothing here fits data yet.

## 1. Pick a planet

Type a name (WASP-39 b is the default) and press **Look up**. The catalogue fills the planet's mass and radius, the
star's radius and temperature, and a/R★; the equilibrium temperature follows from the last two. Any number can be
typed over.

The picture at the top is the planet as an eye would see it: the model's spectrum between 0.38 and 0.75 µm under
the star's light. **Day side**, **Terminator**, **Night side** and **Transit** move the camera; drag to turn it
yourself. The atmosphere is a thin skin, so "Height of the atmosphere" can draw it 3, 10 or 30 times taller than
it is. That changes only the drawing: the light passing through each layer is the same.

## 2. Read the spectrum

**Transmission** is the transit depth against wavelength: where a gas absorbs, the planet looks bigger. The white
line is the whole atmosphere; the coloured lines are each gas alone, so you can see who makes which feature.
**Emission** is the eclipse depth: the planet's own light over the star's.

The status line under the plot gives the size of one scale height in ppm of transit depth. Features are a few
scale heights tall; if they are much smaller than your data's error bars, the data cannot see them.

## 3. See where the spectrum comes from

Under **Structure**, the left plot is temperature against pressure. The shaded band marks the pressures the
spectrum is sensitive to at the wavelength of the slider: in transmission, where starlight grazing the planet's
edge (the limb) goes from passing to blocked. Slide into a water band and the band climbs to lower pressure.
Under **Opacity and where the spectrum forms**, the left plot shows what absorbs at one pressure level and the
right plot shows, for every wavelength, the pressure where the atmosphere turns opaque.

## 3b. Let the gases set the temperature

Under **Temperature profile**, the kind *Radiative balance (from the gases)*, which the page starts with, needs only the equilibrium temperature
and the internal temperature. The page then works the profile out: how much starlight the gases absorb at each
level, how well they hold heat in, and the planet's energy budget, repeated with the chemistry until nothing
moves. It takes a few seconds. Raise the metals, add a cloud, or change the star's temperature and the profile
follows; with the fixed kinds it would not. The card reports whether the planet emits what it takes in. It is a
simplified solution (a grey solution's shape with the real opacities in it), not a full climate model: upper layers
come out warmer than a full calculation gives.

*Heat spread f* says how far the absorbed starlight is shared: 0.25 for the whole planet, 0.5 for a day side that
keeps its heat. To see a **temperature inversion**, choose *WASP-121 b, day side* under **Start from a world**: its
titanium and vanadium oxides absorb starlight high up, and the profile rises by about 250 K between 20 and 2 mbar.
Untick TiO and VO and it goes away. Whether a real planet has an inversion is for its data to say; the model makes
one only when the gas it is given absorbs starlight better than it holds heat.

## 4. Let chemistry choose the gases

By default each gas has its own slider. Set **Gases** to *chemical equilibrium* and two numbers replace them:

- **Metals × Sun**: every element heavier than helium, relative to the Sun. A planet that formed from its star's
  material starts at the star's value, which the page shows when the catalogue has it; giant planets are often
  richer (Jupiter about 3 times, Neptune about 80 times in carbon).
- **C/O**: the carbon-to-oxygen ratio. The Sun's is 0.59. Near 1 the chemistry turns over: water gives way to
  methane and HCN.

The mixing ratios shown are at 10 mbar. Tick a gas to include its absorption. Things to try:

| Change | What happens |
| --- | --- |
| Metals from 1 to 100 × | More absorbers, but a heavier atmosphere: features first grow, then shrink as the scale height falls |
| C/O from 0.59 to 1.1 | Water bands fade, methane and HCN appear |
| Equilibrium temperature from 1100 K to 700 K | CO gives way to CH4 |
| Tick **Quench** at 1 bar on a cool planet | CO and CH4 keep their deep values up high, as vertical mixing would make them |

The chemistry is gas phase only. Nothing condenses, so on a cool planet TiO, VO, Na and K are overstated, and no
cloud forms by itself.

## 5. Add clouds and hazes

Real spectra are often flatter in the visible than a clear atmosphere allows. **Start from** offers presets; each
is a set of the parameters below it:

- a **grey deck**: nothing passes below a pressure; it cuts the bottom off every feature
- a **particle layer**: grains of one size between two pressures; small grains scatter blue light most (a slope
  toward the blue), large ones are grey
- a **power-law haze** and a **Rayleigh strength**: slopes without a grain size
- the **share of the planet covered**: a patchy cloud mimics a higher mean molecular weight

Watch the picture as well as the spectrum: a Rayleigh haze turns the limb blue and the transmitted starlight red.

## 6. Give the planet a night side

Under the temperature profile, **Night side cooler by (K)** runs the model three times: the day side as set, a
night side with less irradiation, and the limb at the mean of the two. The emission spectrum is then the day
side's and the transmission spectrum the limb's. Open the **Cutaway** and colour it by temperature: the side
facing the star is hot, the far side cool, with a smooth gradient between. With chemical equilibrium on, colour it
by a gas instead (methane, say) and the chemistry changes from day to night. It is an interpolation between two
profiles, not a circulation model: there are no winds and no hot-spot shift.

## 7. Ionize the upper atmosphere

**Ionization by starlight** removes from the gas the hydrogen, sodium and potassium atoms that the star's
ultraviolet ionizes at low pressure, and adds their electrons. The composition plot shows Na+, K+ and H+ rising
toward the top.
Sodium's line cores form highest, so they weaken first: put the layer slider under "Opacity" above the pressure
the card reports and the sodium line drops there, while at 10 mbar nothing changes. Hydrogen is ionized only when
chemical equilibrium supplies atomic hydrogen. Molecules are not broken up by the light, potassium's rates are partly estimated, and the star's
ultraviolet is approximate: read the result as the size of the effect.

To see sodium at all, the spectrum's range must reach 0.59 µm: the default range starts at 0.3 µm. From 0.6 µm
on, only the line's red wing shows, and it looks like a haze slope.

## 8. Take the spectrum further

**Use in the simulator** keeps the spectrum for the Spectroscopy page, which can simulate a JWST or Ariel
observation of it. **Save CSV** and **Save figure** export what is plotted.

## 7. Cool planets: condensation and rain-out

Tick **Condense and rain out** in the Composition card. Each gas is then limited by what its condensate allows:
water, ammonia and methane by their vapour pressure, and TiO, VO, sodium and potassium by the solids they form
(perovskite, Na2S, KCl). Rained-out material does not come back up, so above the coldest level a gas has passed it
stays depleted even where the air is warmer again. The card lists the clouds that form and the pressure each begins
at, and how much of each gas is left at the top.

Try *Jupiter* under **Start from a world**: ammonia ice forms from 0.56 bar and water from 6 bar, both vanish above,
and methane is left to shape the spectrum. In the Clouds card, *Place it at the base of* puts the particle layer
where a named cloud begins; its thickness and grain size are still yours to set. On a hot Jupiter with the profile
taken from the gases, rain-out is what removes TiO, and with it the inversion, below about 2000 K at depth.

## 8. A nitrogen world: Titan

*Titan* under **Start from a world** sets a nitrogen atmosphere over a solid surface at 1.47 bar, the temperatures
Huygens measured, 5.65% methane at the surface with the cold trap above it, and a haze of tholin: the orange
organic material made in the laboratory by Khare and others (1984). Three things to look at:

- the planet view is orange, because the haze absorbs blue light and scatters red;
- in **Transmission** the haze lifts a transit at 0.88 µm to about 300 km and slopes down to the red, with
  methane's bands standing on it, as Cassini saw when it watched the Sun set through the atmosphere;
- in the Opacity panel the far infrared is collision-induced absorption of N2-N2 and N2-CH4.

The haze has three numbers: grain size, optical depth at 1 µm, and how it is spread with height (x below 1 puts
more of it high up). They are tuned to Cassini's occultations; Titan's real haze is fluffy aggregates, so the grain
size is an effective one. **Bulk gas** in the Composition card switches any model between hydrogen-helium, nitrogen
and carbon dioxide. *Saturation allowed* of about 0.6 brings the stratospheric methane down to the measured 1.5%.

## Reading the plots, and taking the model with you

- **Which line is which.** Move the pointer over a curve in the Composition or Opacity plot, or over its name in
  the legend: that curve is drawn heavier, its name underlined, and the others dimmed. A click or a tap holds the
  choice; click it again, or empty space, to let go. Each gas keeps one colour in every plot; an ion (Na+, K+, H+)
  has its atom's colour and a dashed line. The legends list only what is present, so switching ionization or a gas
  on or off changes them.
- **From spectrum to colour.** Under *How this is computed*, a figure shows the three response curves of the eye
  (the CIE colour-matching functions) with the spectra the planet view is made from drawn over them, and the
  colours that result.
- **Download everything** (next to *Save CSV*) saves a zip: the model as run, the spectrum with each gas alone, the
  profile and every gas's mixing ratio, the opacity of every absorber at one level per decade of pressure, both
  maps, the colour data, a README, and `figures.py`, which redraws the figures with numpy and matplotlib.
- **The star's spectrum.** Eclipse depths are computed over a model star (PHOENIX) by default; choose *blackbody*
  in the Planet and star card to see the difference.

## 9. Many runs: making it fast

One model with the shipped tables takes about a quarter of a second. For a fit that is too slow, and most of it is
not needed: `prepareTables` cuts the tables to the data's wavelength range and joins neighbouring bins, and the
mixing of gases runs in WebAssembly. Over 0.6 to 5.3 µm at resolving power 100 with 40 layers a model takes 26 ms,
within 3.5 ppm rms of the full tables (`node tools/opacity/speed_study.mjs` prints the table).

## From Python, and from an assistant

```python
import esl
r = esl.atmosphere("Titan", wl_min=0.6, wl_max=5.3, R=100)       # needs the repository's public/ folder (or public=...)
r["wl"], r["depth"], r["profile"]["t"], r["clouds"]
hot = esl.atmosphere(model=dict(tp=dict(kind="consistent", teq=1450), chemistry=dict(mh=0.5), condensation=dict(rainout=True)))
```

The MCP server (`mcp/server.mjs`) has the tool `atmosphere_spectrum`: it takes a world and changes to it, writes the
spectrum to a CSV file in the workspace and describes it.

## Fitting a spectrum (retrieval)

The same model can be fitted to a measured spectrum with the site's nested sampler: free parameters with uniform
priors, a posterior for each, and ln Z to compare two descriptions (with and without a gas or a cloud). There is no
page for it yet; three ways reach it:

- **The assistant on the Atmosphere page**: give it a spectrum file (rows of `wavelength, value, error`, micron) and
  ask it to fit, say, the temperature, [M/H], C/O and radius. Its tool `atmosphere_fit_spectrum` runs the fit in the
  page, draws the points on the spectrum and sets the model to the median, so every figure shows the fit. The
  profile must be "Guillot" or "isothermal". A fit of four parameters takes one to five minutes; if it stops before
  converging the assistant says so and the model is left as it was.
- **Python**: `esl.retrieve_atmosphere([dict(kind="transit", wl=..., y=..., err=...)], ["t", "logX_H2O", "rplanet"], model=...)`.
- **The MCP server**: `atmosphere_retrieve`, on CSV files in the workspace.

For speed the fit runs on 30 layers, and joins opacity bins when the data's resolving power is low (three model bins
to one data bin). Against the full model that costs 8 ppm rms for the layers and 4 ppm for bins joined by 2
on a hot Jupiter at R = 30 ([validation](./validation), "Retrieval"): for data better than about 10 ppm, set
`merge` to 1 and more layers (Python, MCP). A file without bin edges is taken to have bins that meet halfway
between its wavelengths. The spectra and their errors are taken as given: no light curves are fitted with them.

## From a script

The same model runs in Node:

```js
import { readFileSync } from 'node:fs';
import { parseTable } from './src/core/opacity.js';
import { parseChem } from './src/core/chemistry.js';
import { forwardModel, DEFAULT_MODEL } from './src/core/rtmodel.js';
import { escapeHistory } from './src/core/escape.js';

const load = (f) => { const b = readFileSync(f); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const tables = {
  lines: ['H2O', 'CO2', 'CO', 'CH4'].map((s) => parseTable(load(`public/opacity/${s}.eslo`))),
  cia: ['H2-H2', 'H2-He'].map((s) => parseTable(load(`public/opacity/${s}.eslo`))),
  chem: parseChem(load('public/chem/equilibrium.eslc')),
};
const r = forwardModel({ ...DEFAULT_MODEL, chemistry: { mh: 1, co: 0.59 }, cloudTop: 1e-3, cloudFraction: 0.5 }, tables);
// or in one call, with the tables cut to the data: import { runAtmosphere } from './src/core/atmoapi.js';
//   runAtmosphere({ world: 'Titan', wlMin: 0.6, wlMax: 5.3, R: 100 }, tables)
console.log(r.wl[100], r.depth[100], r.fpfs[100]);          // micron, transit depth, eclipse depth

const e = escapeHistory({ mplanet: 0.02, rplanet: 0.24, mstar: 0.5, a: 0.06, T: 700, ageGyr: 5, envelope: 0.02 });
console.log(e.now.mdot, e.lostShare, e.enrich);             // kg/s, share of the envelope lost, enrichment factors
// escape is an estimate kept in the code; it is not on the page
```
