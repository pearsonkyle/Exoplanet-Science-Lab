<script setup>
import { ref } from 'vue';
import { mcp, callTool } from './mcp.js';
const props = defineProps({ tool: String, args: { type: Object, default: () => ({}) } });
const open = ref(false), text = ref(JSON.stringify(props.args, null, 2)), out = ref(''), bad = ref(false), busy = ref(false);
async function run() {
  busy.value = true; out.value = 'Running…'; bad.value = false;
  try { const r = await callTool(props.tool, JSON.parse(text.value || '{}')); out.value = r.text; bad.value = r.isError; }
  catch (err) { out.value = String(err.message || err); bad.value = true; }
  finally { busy.value = false; }
}
</script>
<template>
  <details class="try" :open="open" @toggle="open = $event.target.open">
    <summary>Try <code>{{ tool }}</code></summary>
    <textarea v-model="text" spellcheck="false" :aria-label="`Arguments for ${tool}, as JSON`"></textarea>
    <div class="row"><button :disabled="busy || !mcp.ok" @click="run">Call {{ tool }}</button><span class="st">{{ mcp.ok ? 'arguments as JSON' : 'connect first (top of the page)' }}</span></div>
    <pre v-if="out" class="out" :class="{ bad }">{{ out }}</pre>
  </details>
</template>
