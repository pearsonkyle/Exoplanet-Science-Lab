// The kind of window a link from the planner carries (transit=<start>,<mid>,<end> plus event=eclipse|phase|custom):
// its name and the words for its three times, on the card, the track and the immersive card. No DOM
// (test/discovery.test.mjs runs it). Colours are those of the planner (KIND_COLOUR in src/plan/chart.js; the test
// checks they agree), except the transit, which keeps the sky's own track colour. They are drawn with these words
// beside them, so they are not confused with the discovery-method colours of the host rings (src/sky/discovery.js).
export const EVENT_KINDS = {
  transit: { title: 'Transit', word: 'transit', marks: ['Ingress', 'Mid-transit', 'Egress'], rows: ['Ingress', 'Mid', 'Egress'], color: '#5fd4ff', planColor: '#6fdcff' },
  eclipse: { title: 'Eclipse', word: 'eclipse', marks: ['Eclipse ingress', 'Mid-eclipse', 'Eclipse egress'], rows: ['Ingress', 'Mid', 'Egress'], color: '#ffc56b' },
  phase: { title: 'Phase-curve window', word: 'phase-curve window', marks: ['Window start', 'Window middle', 'Window end'], rows: ['Start', 'Middle', 'End'], color: '#f39bd6' },
  custom: { title: 'Custom window', word: 'custom window', marks: ['Window start', 'Window middle', 'Window end'], rows: ['Start', 'Middle', 'End'], color: '#c9d3e6' },
};
/** The URL's event parameter -> a kind of EVENT_KINDS ('transit' when absent or unknown). */
export const eventKind = (v) => { const k = String(v ?? '').trim().toLowerCase(); return Object.hasOwn(EVENT_KINDS, k) ? k : 'transit'; };
export const eventInfo = (kind) => EVENT_KINDS[eventKind(kind)];
