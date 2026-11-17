// The companion explorer's geometry (src/ui/companionplot.js) and the time left of a long job (src/site/jobs.js).
import { orbitPoint, aAU, mapLayout } from '../src/ui/companionplot.js';
import { etaSeconds } from '../src/site/jobs.js';
let ok = true; const check = (name, cond, info = '') => { console.log((cond ? 'ok   ' : 'FAIL ') + name + (info ? '   ' + info : '')); if (!cond) ok = false; };
const near = (a, b, t) => Math.abs(a - b) <= t;

// Kepler's third law in AU, solar masses and days
check('a from Kepler\'s third law: Earth 1 AU, Jupiter 5.20 AU, Mercury 0.387 AU', near(aAU(365.25, 1), 1, 1e-12) && near(aAU(4332.59, 1 + 9.55e-4), 5.2026, 0.001) && near(aAU(87.969, 1), 0.3871, 0.0002));

// a circular orbit: at transit the planet is between the star and the observer (Z = +a, X = 0), a quarter orbit later
// at X = +a (the sky convention of the transit model: X = -r cos(ω + ν), Z = r sin(ω + ν))
const c = { a: 2, e: 0, omega: 90, per: 10, tmid: 3 };
const p0 = orbitPoint(c, 3), p1 = orbitPoint(c, 5.5), p2 = orbitPoint(c, 8), p3 = orbitPoint(c, 13);
check('circular orbit: transit on the line of sight toward the observer', near(p0[0], 0, 1e-12) && near(p0[1], 2, 1e-12));
check('circular orbit: a quarter, a half and a whole period later', near(p1[0], 2, 1e-12) && near(p1[1], 0, 1e-12) && near(p2[0], 0, 1e-12) && near(p2[1], -2, 1e-12) && near(p3[0], p0[0], 1e-12) && near(p3[1], p0[1], 1e-12));

// an eccentric orbit: at transit, r = a(1 - e²)/(1 + e cos ν) with ν = 90° - ω, still on the line of sight
const e = { a: 1, e: 0.6, omega: 30, per: 100, tmid: 0 }, nu = (90 - 30) * Math.PI / 180, rT = (1 - 0.36) / (1 + 0.6 * Math.cos(nu));
const q = orbitPoint(e, 0);
check('eccentric orbit: transit on the line of sight at the conic radius', near(q[0], 0, 1e-12) && near(q[1], rT, 1e-12), `Z ${q[1].toFixed(12)} against ${rT.toFixed(12)}`);
// equal areas in equal times: the areal speed is constant (Kepler's second law)
let worst = 0; const dt = 1e-3, A0 = (t) => { const [x0, z0] = orbitPoint(e, t), [x1, z1] = orbitPoint(e, t + dt); return 0.5 * Math.abs(x0 * z1 - x1 * z0) / dt; };
const ref = Math.PI * 1 * Math.sqrt(1 - 0.36) / 100;   // ellipse area / period
for (const t of [0, 13, 37, 51, 77, 99]) worst = Math.max(worst, Math.abs(A0(t) / ref - 1));
check('eccentric orbit: equal areas in equal times (Kepler\'s second law)', worst < 1e-5, `largest deviation ${worst.toExponential(1)}`);

// the map's axes invert exactly (the hit test of the panel uses them)
const L = mapLayout(600, 300, { basePeriod: 10, samples: [{ ratio: 2.03, mass: 0.6 }, { ratio: 2.05, mass: 0.75 }] });
check('map axes: pixel ↔ (period ratio, mass) round trip', near(L.ratioAt(L.X(2.04)), 2.04, 1e-12) && near(L.massAt(L.Y(0.66)), 0.66, 1e-12));

// time left from the recent rate: progress at 1% a second, read at 40% after 40 s, is about 60 s
const hist = Array.from({ length: 41 }, (_, i) => ({ t: 1e6 + 1000 * i, f: 0.01 * i }));
check('time left from a steady rate', near(etaSeconds(hist, 1e6 + 40000), 60, 0.5), etaSeconds(hist, 1e6 + 40000).toFixed(2));
// a run that sped up: the recent rate counts, not the average since the start
const fast = [...Array.from({ length: 200 }, (_, i) => ({ t: 1e6 + 6000 * i, f: 0.001 * i })), ...Array.from({ length: 100 }, (_, i) => ({ t: 1e6 + 1.2e6 + 1000 * i, f: 0.2 + 0.004 * i }))];
const eta = etaSeconds(fast, fast.at(-1).t);
const recent = (1 - 0.596) / 0.004, average = (1 - 0.596) / (0.596 / ((fast.at(-1).t - 1e6) / 1000));
check('time left follows the recent rate after a speed-up (within 20% of it, far from the whole-run average)', Math.abs(eta / recent - 1) < 0.2 && Math.abs(eta - recent) < 0.1 * Math.abs(average - recent), `${eta.toFixed(0)} s (the average since the start would say ${((1 - 0.596) / (0.596 / ((fast.at(-1).t - 1e6) / 1000))).toFixed(0)} s)`);
check('no estimate before there is progress to go on', Number.isNaN(etaSeconds([{ t: 0, f: 0 }, { t: 1000, f: 0.001 }], 1000)));
process.exit(ok ? 0 : 1);
