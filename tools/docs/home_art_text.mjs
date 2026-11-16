// Typeset pieces for the home page's card art (tools/docs/home_art.py): the Methods card's equations as MathJax SVG
// and the Docs card's Python as Shiki HTML. Prints JSON { equations: [svg...], code: html } on stdout.
import { mathjax } from 'mathjax-full/js/mathjax.js';
import { TeX } from 'mathjax-full/js/input/tex.js';
import { SVG } from 'mathjax-full/js/output/svg.js';
import { liteAdaptor } from 'mathjax-full/js/adaptors/liteAdaptor.js';
import { RegisterHTMLHandler } from 'mathjax-full/js/handlers/html.js';
import { AllPackages } from 'mathjax-full/js/input/tex/AllPackages.js';
import { codeToHtml } from 'shiki';

const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);
const doc = mathjax.document('', { InputJax: new TeX({ packages: AllPackages }), OutputJax: new SVG({ fontCache: 'none' }) });
const tex = (s) => adaptor.innerHTML(doc.convert(s, { display: true }));

// the relations the site's models rest on (src/core): Kepler's third law, equilibrium temperature, transit depth,
// the RV semi-amplitude and the limb-darkening law in the convention of CLAUDE.md
const EQUATIONS = [
  String.raw`\frac{a^3}{P^2} = \frac{G\,(M_\star + M_p)}{4\pi^2}`,
  String.raw`T_\mathrm{eq} = T_\star \sqrt{\frac{R_\star}{2a}}\,\left(1 - A_B\right)^{1/4}`,
  String.raw`\delta \simeq \left(\frac{R_p}{R_\star}\right)^{2}`,
  String.raw`K = \left(\frac{2\pi G}{P}\right)^{1/3} \frac{M_p \sin i}{(M_\star + M_p)^{2/3}\sqrt{1-e^2}}`,
  String.raw`I(\mu) = 1 - \sum_{n=1}^{4} a_n \left(1 - \mu^{n/2}\right)`,
];

// condensed from python/labs/src/lab02_tess_transit.py: the calls are the package's own
const CODE = `from esl import lookup, read_light_curve, Data, FitSettings, FreeParameter, Prior

cat = lookup("HD 80606 b")          # catalogue values, with sources
lc = read_light_curve(text, name="TESS sector 21")

session = cat.session.model_copy(update=dict(
    data=Data(light_curve=lc),
    fit=FitSettings(free=[
        FreeParameter(key="rprs", prior=Prior.uniform(0.05, 0.15)),
        FreeParameter(key="tmid", prior=Prior.uniform(t0 - 0.05, t0 + 0.05)),
    ]),
))
fit = session.run()                 # nested sampling, the browser's own core
print(fit.result.table())`;

const code = await codeToHtml(CODE, { lang: 'python', theme: 'tokyo-night' });
process.stdout.write(JSON.stringify({ equations: EQUATIONS.map(tex), code }));
