// The mixing of k-distributions (random overlap, resorted, log mean back onto the g-points) for every layer and
// bin: the inner loop of gasExtinction in src/core/opacity.js, line for line, compiled to WebAssembly.
// Build: tools/wasm/build.sh (rustc with the wasm32-unknown-unknown target). The JavaScript in opacity.js is the
// reference; test/opacity.test.mjs checks that the two agree.
use std::alloc::{alloc as sys_alloc, dealloc as sys_dealloc, Layout};

#[no_mangle]
pub extern "C" fn esl_alloc(bytes: usize) -> *mut u8 { unsafe { sys_alloc(Layout::from_size_align(bytes.max(8), 8).unwrap()) } }

#[no_mangle]
pub unsafe extern "C" fn esl_free(p: *mut u8, bytes: usize) { sys_dealloc(p, Layout::from_size_align(bytes.max(8), 8).unwrap()) }

/// ln x for positive finite x: exponent, then the atanh series on the mantissa in [1/sqrt2, sqrt2). Relative error
/// of the result below 3e-8 x |ln mantissa|, far inside what a 12-point k-distribution carries.
#[inline(always)]
fn fast_ln(x: f64) -> f64 {
    let bits = x.to_bits();
    let mut e = ((bits >> 52) & 0x7ff) as i64 - 1023;
    let mut m = f64::from_bits((bits & 0x000f_ffff_ffff_ffff) | 0x3ff0_0000_0000_0000);
    if m > core::f64::consts::SQRT_2 { m *= 0.5; e += 1; }
    let s = (m - 1.0) / (m + 1.0); let s2 = s * s;
    (e as f64) * core::f64::consts::LN_2 + 2.0 * s * (1.0 + s2 * (1.0 / 3.0 + s2 * (0.2 + s2 * (1.0 / 7.0 + s2 * (1.0 / 9.0)))))
}

#[inline(always)]
fn overlap(a: &mut [f64; 16], b: &[f64; 16], ng: usize, w: &[f64], val: &mut [u64; 256], wt: &[f64; 256]) {
    let m = ng * ng;
    let mut q0 = 0;
    // positive doubles order as their bit patterns: the pair's index rides in the lowest 8 bits (a change below 1e-13)
    for i in 0..ng { for j in 0..ng { val[q0] = ((a[i] + b[j]).to_bits() & !0xffu64) | q0 as u64; q0 += 1; } }
    val[..m].sort_unstable();
    let at = |k: usize| f64::from_bits(val[k]);
    let log = at(0) > 0.0 && at(0) >= f64::MIN_POSITIVE;
    let (mut k, mut cum, mut lo) = (0usize, 0.0f64, 0.0f64);
    let mut wk = wt[(val[0] & 255) as usize];
    let mut cur = if log { fast_ln(at(0)) } else { at(0) };
    for q in 0..ng {
        let hi = if q == ng - 1 { 2.0 } else { lo + w[q] };
        let (mut s, mut got) = (0.0f64, 0.0f64);
        while k < m {
            let end = cum + wk; let from = if cum > lo { cum } else { lo };
            if end <= hi {
                s += (end - from) * cur; got += end - from; cum = end; k += 1;
                if k < m { let x = at(k); wk = wt[(val[k] & 255) as usize]; cur = if log { fast_ln(x) } else { x }; }
            } else { s += (hi - from) * cur; got += hi - from; break; }
        }
        a[q] = if log { (s / got).exp() } else { s / got };
        lo = hi;
    }
}

/// sig: ns blocks of n * m cross-sections (layer, then bin, then g); fac: ns * n number densities x mixing ratios;
/// w: ng weights; ext: m * n out (bin and g, then layer), every entry written.
#[no_mangle]
pub unsafe extern "C" fn esl_mix(sig: *const f64, fac: *const f64, w: *const f64, ext: *mut f64, ns: usize, n: usize, n_wl: usize, ng: usize, grey_below: f64) {
    let m = n_wl * ng;
    let sig = core::slice::from_raw_parts(sig, ns * n * m);
    let fac = core::slice::from_raw_parts(fac, ns * n);
    let w = core::slice::from_raw_parts(w, ng);
    let ext = core::slice::from_raw_parts_mut(ext, m * n);
    let mut wt = [0.0f64; 256];
    for i in 0..ng { for j in 0..ng { wt[i * ng + j] = w[i] * w[j]; } }
    let mut val = [0u64; 256];
    let (mut mean, mut low) = ([0.0f64; 64], [0.0f64; 64]);
    let (mut acc, mut part) = ([0.0f64; 16], [0.0f64; 16]);
    for j in 0..n {
        for i in 0..n_wl {
            let base = j * m + i * ng;
            let mut floor = 0.0f64;
            for s in 0..ns {
                let f = fac[s * n + j]; let sg = &sig[s * n * m + base..s * n * m + base + ng];
                let mut a = 0.0; for q in 0..ng { a += w[q] * sg[q]; }
                mean[s] = f * a; low[s] = f * sg[0]; if low[s] > floor { floor = low[s]; }
            }
            for q in 0..ng { acc[q] = 0.0; }
            let (mut first, mut grey) = (true, 0.0f64);
            for s in 0..ns {
                if !(mean[s] > 0.0) { continue; }
                if mean[s] < grey_below * floor && low[s] < floor { grey += mean[s]; continue; }
                let f = fac[s * n + j]; let sg = &sig[s * n * m + base..s * n * m + base + ng];
                if first { for q in 0..ng { acc[q] = f * sg[q]; } first = false; }
                else { for q in 0..ng { part[q] = f * sg[q]; } overlap(&mut acc, &part, ng, w, &mut val, &wt); }
            }
            for q in 0..ng { ext[(i * ng + q) * n + j] = acc[q] + grey; }
        }
    }
}
