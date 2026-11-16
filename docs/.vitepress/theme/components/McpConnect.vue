<script setup>
import { mcp, connect } from './mcp.js';
</script>
<template>
  <div class="try">
    <div class="row">
      <input v-model="mcp.url" aria-label="MCP server address" spellcheck="false" />
      <button :disabled="mcp.busy" @click="connect">{{ mcp.ok ? 'Reconnect' : 'Connect' }}</button>
    </div>
    <p class="st" :class="{ ok: mcp.ok, bad: !mcp.ok && mcp.status && !mcp.busy }" role="status">{{ mcp.status || 'Not connected. Start your server, then press Connect.' }}</p>
  </div>
</template>
