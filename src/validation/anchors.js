// Anchors of the validation part of the Methods page (methods/, tab "Validation"). Pure, no DOM.
//
// The validation sections and the topic cards share one document with the per-technique Methods sections, whose ids
// (transit, rv, sampler, photometry, ...) would collide with theirs, so every top-level validation id carries the
// prefix "val-": #val-summary, #val-transit, #val-sampler. Ids inside them (transit-cases, rv-conventions, codes,
// all-checks) are unique already and keep their names. The old page validation/ redirects #x to methods/#val-x, and
// the Methods page falls back to #x when there is no #val-x, so every old address still lands where it did.

import { TOPICS } from './topics.js';

/** Top-level ids of the validation part, unprefixed (the topic ids of topics.js are added to these). */
export const VALIDATION_SECTIONS = ['summary', 'weaker', 'outliers', 'comparisons', 'transit', 'orbit', 'rv', 'fits', 'project', 'reproduce', 'limits'];
const TOP = new Set([...VALIDATION_SECTIONS, ...TOPICS.map((t) => t.id)]);

/** The id on the page of a validation anchor: "transit" -> "val-transit", "transit-cases" -> "transit-cases". */
export const vid = (id) => { const x = String(id).replace(/^#/, ''); return TOP.has(x) ? 'val-' + x : x; };
