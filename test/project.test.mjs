// The observing project record (src/site/project.js): normalisation, merging, step states, advancing, addresses,
// fit records, and storage through a stand-in for localStorage. No page needed.
import { STEPS, normalize, newProject, merge, stepStates, currentStep, advance, stepHref, fitRecord, loadProject, saveProject, PROJECT_KEY } from '../src/site/project.js';

let ok = true; const check = (name, cond, info = '') => { console.log((cond ? 'ok   ' : 'FAIL ') + name + (info ? '   ' + info : '')); if (!cond) ok = false; };
const mem = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };

check('nine steps from target to report', STEPS.map((s) => s.id).join() === 'target,plan,observe,reduce,fit,rv,joint,compare,report');
check('normalize refuses what is not a project', normalize(null) === null && normalize({ v: 2 }) === null && normalize({ target: {} }) === null);
let p = newProject();
check('a new project starts at choosing the target', currentStep(p).id === 'target' && stepStates(p).every((s) => !s.done) && Array.isArray(p.files) && Array.isArray(p.fits));
p = merge(p, { target: { name: 'HAT-P-32 b' } });
check('setting the target completes step 1 and moves on', stepStates(p)[0].done && stepStates(p)[0].auto && currentStep(p).id === 'plan');
p = merge(p, { target: { per: 2.15 } });
check('objects merge', p.target.name === 'HAT-P-32 b' && p.target.per === 2.15);
p = advance(p);
check('advance marks plan done by hand and goes to observe', p.done.plan && currentStep(p).id === 'observe');
p = merge(p, { files: [...p.files, { kind: 'lightcurve', name: 'lc.csv' }] });
check('a light curve completes the reduction step (observe still open)', stepStates(p).find((s) => s.id === 'reduce').done && currentStep(p).id === 'observe');
p = merge(p, { step: 'fit' });
check('choosing a step', currentStep(p).id === 'fit');
const res = { parameters: [{ key: 'rprs', median: 0.15, plus: 0.001, minus: 0.001 }], derived: { K: { median: 50, plus: 1, minus: 1 } }, logZ: 10, logZerr: 0.2, chi2: 100, n_data: 99, converged: true };
const fr = fitRecord(res, { use: { lc: true } });
check('fit record keeps the key numbers', fr.values.rprs.median === 0.15 && fr.values.K.median === 50 && fr.use.lc && !fr.use.rv && fr.free.join() === 'rprs');
p = merge(p, { fits: [fr], step: null });
check('a light-curve fit completes "fit"; the next open step is observe', stepStates(p).find((s) => s.id === 'fit').done && currentStep(p).id === 'observe');
p = merge(p, { fits: [fr, fitRecord(res, { use: { lc: true, rv: true } })], files: [...p.files, { kind: 'rv', name: 'HIRES' }] });
check('joint fit and two fits complete joint and compare', ['rv', 'joint', 'compare'].every((id) => stepStates(p).find((s) => s.id === id).done));
p = merge(p, { done: null });
check('null clears a field', Object.keys(p.done).length === 0);
// addresses
const q = merge(newProject(), { target: { name: 'HD 80606 b' } });
check('addresses carry the target', stepHref(STEPS[1], q) === 'plan/?planet=HD%2080606%20b' && stepHref(STEPS[5], q) === 'analyze/?planet=HD%2080606%20b&rv=find' && stepHref(STEPS[3], q) === 'analyze/photometry/' && stepHref(STEPS[0], newProject()) === 'search/', [1, 5, 3].map((i) => stepHref(STEPS[i], q)).join(' '));
let threw = false; try { advance(q, 'nope'); } catch { threw = true; } check('advance to an unknown step throws', threw);
// storage
const st = mem();
check('no project stored: null', loadProject(st) === null);
saveProject(q, st);
check('saved and read back', loadProject(st).target.name === 'HD 80606 b' && JSON.parse(st.getItem(PROJECT_KEY)).v === 1);
st.setItem(PROJECT_KEY, '{not json'); check('a corrupt record reads as none', loadProject(st) === null);
process.exit(ok ? 0 : 1);
