<script setup>
// The real analyzer in an iframe from this site, and a small editor that runs JavaScript against its
// window.__esl.api. Same origin is required (the docs are published next to the app); nothing leaves the browser.
import { ref, onMounted } from 'vue';
const SNIPPETS = {
  'List the worked examples': `return api.examples().map((e) => e.id + ': ' + e.title);`,
  'Open an example and read its fit': `await api.loadExample('single');\nconst r = api.results();\nreturn r.parameters.map((p) => \`\${p.key} = \${p.median} +\${p.plus} -\${p.minus}\`);`,
  'Change a value and read the model': `api.setValue('rprs', 0.12);\nconst s = api.state();\nreturn { rprs: s.parameters.find((p) => p.key === 'rprs').value, chi2: s.chi2 };`,
  'Run a fit (about 5 s)': `await api.loadExample('single', { fresh: true });\nfor (const k of ['rprs', 'inc', 'tmid']) api.setFree(k, true);\nconst r = await api.run();\nreturn { logZ: r.logZ, parameters: r.parameters.map((p) => [p.key, p.median, p.plus, p.minus]) };`,
  'Everything the API offers': `return api.describe().map((f) => f.name + ': ' + f.description);`,
};
const siteRoot = (typeof __SITE_URL__ !== 'undefined' ? __SITE_URL__ : '/');
const frame = ref(null), code = ref(SNIPPETS['List the worked examples']), out = ref(''), bad = ref(false), busy = ref(false), ready = ref(false), note = ref('');
const pick = ref('List the worked examples');
const src = new URL('analyze/?skipintro&noassistant&noproject', new URL(siteRoot, typeof location !== 'undefined' ? location.href : 'http://x/')).href;
function api() {
  try { return frame.value.contentWindow.__esl.api; } catch { return null; }   // cross-origin: the docs are not served next to the app
}
onMounted(() => {
  const t0 = Date.now(), poll = setInterval(() => {
    if (api()) { ready.value = true; note.value = ''; clearInterval(poll); }
    else if (Date.now() - t0 > 20000) { clearInterval(poll); note.value = `The analyzer did not answer. The playground needs the docs and the app on one site (as on GitHub Pages, or npm run pages:preview locally); it looked for the app at ${src}.`; }
  }, 400);
});
async function run() {
  const a = api(); if (!a) return;
  busy.value = true; bad.value = false; out.value = 'Running…';
  try {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const r = await new AsyncFunction('api', code.value)(a);
    out.value = r === undefined ? 'Done (return a value to see it).' : typeof r === 'string' ? r : JSON.stringify(r, null, 2);
  } catch (err) { out.value = String(err.message || err); bad.value = true; } finally { busy.value = false; }
}
</script>
<template>
  <div class="try">
    <div class="row">
      <select v-model="pick" @change="code = SNIPPETS[pick]" aria-label="Example snippets"><option v-for="(v, k) in SNIPPETS" :key="k">{{ k }}</option></select>
      <button :disabled="!ready || busy" @click="run">Run</button>
      <span class="st" :class="{ ok: ready }">{{ ready ? 'analyzer ready' : 'loading the analyzer…' }}</span>
    </div>
    <textarea v-model="code" spellcheck="false" aria-label="JavaScript to run against api"></textarea>
    <pre v-if="out" class="out" :class="{ bad }">{{ out }}</pre>
    <p v-if="note" class="st bad">{{ note }}</p>
    <iframe ref="frame" :src="src" title="The analyzer, driven by the code above" loading="lazy"></iframe>
  </div>
</template>
