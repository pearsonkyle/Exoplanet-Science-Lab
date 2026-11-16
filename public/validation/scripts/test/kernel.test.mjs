import fs from 'node:fs';
import { blockedFraction, transitModel } from '../src/core/transit.js';
import { prepareLD, toClaret, checkProfile, intensity } from '../src/core/limbdark.js';
import { solveKepler, orbitElements, orbitPosition, derived } from '../src/core/kepler.js';

const ref = JSON.parse(fs.readFileSync(new URL('./reference.json', import.meta.url)));
let worst = { err: 0 }, byLaw = {};
for (const c of ref) {
  const v = blockedFraction(c.z, c.p, prepareLD(c.a));
  const err = Math.abs(v - c.ref);
  byLaw[c.law] = Math.max(byLaw[c.law] || 0, err);
  if (err > worst.err) worst = { err, ...c, got: v };
}
console.log('kernel vs scipy reference, max abs error by law:', byLaw);
console.log('worst case:', worst);

// what a fixed 30-node Gauss-Legendre rule on the radial form gives (pylightcurve-style)
function gl(n){const x=[],w=[];for(let i=0;i<n;i++){let z=Math.cos(Math.PI*(i+0.75)/(n+0.5)),pp;for(let it=0;it<100;it++){let p1=1,p2=0;for(let j=1;j<=n;j++){const p3=p2;p2=p1;p1=((2*j-1)*z*p2-(j-1)*p3)/j;}pp=n*(z*p1-p2)/(z*z-1);const dz=p1/pp;z-=dz;if(Math.abs(dz)<1e-16)break;}x.push(z);w.push(2/((1-z*z)*pp*pp));}return{x,w};}
const G = gl(30);
function radialGL(z, p, a) {
  const I = (r) => { const m2 = Math.max(0, 1 - r*r), m = Math.sqrt(m2), q = Math.sqrt(m); return 1 - a[0]*(1-q) - a[1]*(1-m) - a[2]*(1-m*q) - a[3]*(1-m2); };
  const F = (r) => { const m2 = 1 - r*r, m = Math.sqrt(m2), q = Math.sqrt(m); const c0 = 1-a[0]-a[1]-a[2]-a[3]; return c0*r*r/2 + a[0]*(1-m2*q)/2.5 + a[1]*(1-m2*m)/3 + a[2]*(1-m2*m*q)/3.5 + a[3]*(1-m2*m2)/4; };
  let lo = Math.max(0, z - p), hi = Math.min(1, z + p), full = 0;
  if (p > z) { full = 2*Math.PI*F(Math.min(1, p - z)); lo = Math.min(1, p - z); }
  let s = 0; const m = (lo+hi)/2, h = (hi-lo)/2;
  for (let k = 0; k < 30; k++) { const r = m + h*G.x[k]; s += G.w[k]*I(r)*r*2*Math.acos(Math.min(1, Math.max(-1,(r*r+z*z-p*p)/(2*z*r)))); }
  return (full + s*h)/(2*Math.PI*F(1));
}
let w30 = 0;
for (const c of ref) if (c.law !== 'uniform' && c.z > 1e-5 && c.z < 1 + c.p) w30 = Math.max(w30, Math.abs(radialGL(c.z, c.p, c.a) - c.ref));
console.log('30-node radial Gauss-Legendre, max abs error:', w30.toExponential(2));

// Kepler
let kerr = 0, kit = 0;
for (const e of [0, 0.1, 0.5, 0.9, 0.93366, 0.99, 0.999]) for (let i = 0; i <= 2000; i++) {
  const M = -7 + 14*i/2000; const E = solveKepler(M, e);
  const Mr = M - 2*Math.PI*Math.floor((M+Math.PI)/(2*Math.PI));
  kerr = Math.max(kerr, Math.abs(E - e*Math.sin(E) - Mr));
}
console.log('Kepler residual max:', kerr.toExponential(2));

// geometry: at tmid the planet is at conjunction, in front, with b from the closed form
for (const P of [{per:3.5,tmid:10,ars:8,inc:87,ecc:0,omega:0,rprs:.1},{per:111.4367,tmid:5,ars:97,inc:89.3,ecc:0.93,omega:301,rprs:.1},{per:2.15,tmid:0,ars:5.344,inc:88.98,ecc:0.159,omega:50,rprs:.149}]) {
  const el = orbitElements(P), v = orbitPosition(el, P.tmid, [0,0,0]), d = derived(P);
  console.log('conj X=%s  |Y|=%s  b=%s  Z>0:%s  T14=%s d', v[0].toExponential(1), Math.abs(v[1]).toFixed(6), d.b.toFixed(6), v[2] > 0, d.t14.toFixed(5));
  // numeric duration
  const N = 400001, span = d.t14*1.5, t = Float64Array.from({length:N},(_, i)=>P.tmid - span/2 + span*i/(N-1));
  const f = transitModel(t, {...P, ldLaw:'quadratic', ld:[.4,.26]});
  let a = -1, b = -1; for (let i = 0; i < N; i++) if (f[i] < 1) { if (a < 0) a = i; b = i; }
  console.log('   numeric T14 = %s d   min flux %s', (t[b]-t[a]).toFixed(5), f.reduce((m,v)=>Math.min(m,v),1).toFixed(6));
}
console.log(checkProfile(toClaret('nonlinear',[0.4939,-0.0729,0.4578,-0.2158])), checkProfile(toClaret('quadratic',[1.2,-0.5])));

// speed
const t = Float64Array.from({length: 1000}, (_, i) => -0.15 + 0.3*i/999), out = new Float64Array(1000);
const P = {per:2.15,tmid:0,ars:5.344,inc:88.98,ecc:0.159,omega:50,rprs:.149, ldLaw:'nonlinear', ld:[0.4939,-0.0729,0.4578,-0.2158]};
for (let i = 0; i < 300; i++) transitModel(t, P, out);
let t0 = performance.now(); for (let i = 0; i < 2000; i++) { P.rprs = 0.1 + 1e-5*i; transitModel(t, P, out); }
let dt = (performance.now() - t0)/2000;
console.log('1000-pt eccentric 4-param light curve: %s ms  (%s models/s)', dt.toFixed(4), Math.round(1000/dt));

// intensity() must describe the same profile the kernel integrates: 2 int I(mu) mu dmu = 2 F(1)
{
  let worst = 0;
  for (const a of [[0.4939, -0.0729, 0.4578, -0.2158], [0.6, -0.4, 0.9, -0.3], toClaret('quadratic', [0.4, 0.26]), toClaret('sqrt', [0.1, 0.6])]) {
    let s = 0; const n = 200000; for (let i = 0; i < n; i++) { const mu = (i + 0.5) / n; s += intensity(mu, a) * mu; }
    worst = Math.max(worst, Math.abs(s / n - prepareLD(a).F1));
  }
  console.log('intensity() vs kernel normalisation, max diff:', worst.toExponential(1));
  if (worst > 1e-9) { console.log('FAIL intensity profile inconsistent with kernel'); process.exit(1); }
}
