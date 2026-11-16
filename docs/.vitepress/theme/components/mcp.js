// A minimal MCP client over Streamable HTTP for the docs' Try it panels: initialize, then tools/list and
// tools/call. One connection is shared by every panel on the page. The server must allow this site's origin
// (node mcp/server.mjs ... --allow-origin <origin>); it listens on 127.0.0.1 only.
import { reactive } from 'vue';

export const mcp = reactive({ url: 'http://127.0.0.1:8765/mcp', sid: null, version: '2025-03-26', tools: [], status: '', ok: false, busy: false });
let seq = 0;

async function post(body) {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  if (mcp.sid) { headers['mcp-session-id'] = mcp.sid; headers['mcp-protocol-version'] = mcp.version; }
  const r = await fetch(mcp.url, { method: 'POST', headers, body: JSON.stringify(body) });
  const sid = r.headers.get('mcp-session-id'); if (sid) mcp.sid = sid;
  if (!r.ok && r.status !== 202) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  if (body.id === undefined) return null;
  const ct = r.headers.get('content-type') || '';
  if (ct.includes('text/event-stream')) {
    // the answer is one of the SSE messages: take the one with our id
    const text = await r.text();
    for (const line of text.split('\n')) if (line.startsWith('data:')) { try { const m = JSON.parse(line.slice(5)); if (m.id === body.id) return m; } catch { /* a non-JSON event */ } }
    throw new Error('no answer in the event stream');
  }
  return r.json();
}
async function rpc(method, params) {
  const m = await post({ jsonrpc: '2.0', id: ++seq, method, params });
  if (m.error) throw new Error(m.error.message || JSON.stringify(m.error));
  return m.result;
}

export async function connect() {
  mcp.busy = true; mcp.sid = null; mcp.ok = false; mcp.status = 'Connecting…';
  try {
    const init = await rpc('initialize', { protocolVersion: mcp.version, capabilities: {}, clientInfo: { name: 'esl-docs', version: '1' } });
    mcp.version = init.protocolVersion || mcp.version;
    await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    mcp.tools = (await rpc('tools/list', {})).tools || [];
    mcp.ok = true; mcp.status = `Connected to ${init.serverInfo ? init.serverInfo.name : 'the server'}: ${mcp.tools.length} tools.`;
  } catch (err) {
    const m = String(err.message || err);
    mcp.status = /Failed to fetch|NetworkError|Load failed/.test(m)
      ? `Could not reach ${mcp.url}. Is the server running with --http and --allow-origin ${location.origin}? Chrome may also ask to allow access to devices on your local network: choose Allow. Safari blocks http://localhost from https pages: use Chrome, Edge or Firefox.`
      : m;
  } finally { mcp.busy = false; }
}

export async function callTool(name, args) {
  if (!mcp.ok) throw new Error('connect to your MCP server first (top of the page)');
  const r = await rpc('tools/call', { name, arguments: args });
  const text = (r.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  try { return { isError: !!r.isError, text: JSON.stringify(JSON.parse(text), null, 2) }; } catch { return { isError: !!r.isError, text }; }
}
