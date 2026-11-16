// A conversation with the assistant as training data: one JSON object per conversation, in the OpenAI chat
// fine-tuning shape that most SFT pipelines read (TRL's SFTTrainer with tools, axolotl's chat_template, LLaMA-Factory
// "sharegpt"/"openai" formats after a field map):
//
//   { "messages": [ { role: system | user | assistant | tool, content, ... } ],
//     "tools":    [ { type: "function", function: { name, description, parameters } } ],   JSON schema of every tool
//     "metadata": { format, source, model, protocol, created, page, turns, steps, tool_calls, errors, ... } }
//
// assistant messages carry "reasoning_content" (the model's own thinking, when the server streamed it) and
// "tool_calls" ({ id, type: "function", function: { name, arguments: JSON string } }); tool messages carry
// "tool_call_id" and "name". The prompt is the one the model saw at each step, without the harness's trimming:
// the system primer, the user's words, every tool result in full, the app's nudges as user messages, and the live
// CURRENT STATE card where the harness put it (appended to the last message before each model call). A final
// answer is the model's own words: the table the app appends when the numbers do not match is left out (it is
// recorded in metadata). No DOM; main.js turns this into a file, test/assistant_sft.test.mjs checks it.
//
//   toTrainingRecord({ turns, primer, specs, model, protocol, page, meta })  -> the object above
//   toJsonl(records)                                                        -> one line per record
//   fromTrainingRecord(record)                                              -> turns again (to load a file back)

import { openAITools } from './toolspec.js';

export const FORMAT = 'esl-assistant-sft-v1';
const REQUEST = '\n\nTHE USER\'S REQUEST:\n';

export function toTrainingRecord({ turns = [], primer = '', specs = [], model = '', protocol = 'native', page = '', meta = {} } = {}) {
  const messages = [{ role: 'system', content: primer }];
  let steps = 0, calls = 0, errors = 0, appended = 0;
  const withState = (m, card) => { if (card) m.content = (m.content ? m.content + '\n\n' : '') + card; };
  for (const t of turns) {
    const first = (t.steps && t.steps[0] && t.steps[0].state) || t.finalState || '';
    // as the harness sends it: the state card, then the request last, so the request is what the model reads last
    messages.push({ role: 'user', content: first ? first + REQUEST + t.user : t.user });
    const st = t.steps || [], notes = t.notes || [];
    st.forEach((s, i) => {
      if (i > 0) withState(messages[messages.length - 1], s.state && `${s.state}\n\nThe user's request, for reference: "${short(t.user, 400)}"`);
      const a = { role: 'assistant', content: s.content || '' };
      if (s.reasoning) a.reasoning_content = s.reasoning;
      if (s.calls && s.calls.length) a.tool_calls = s.calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) } }));
      messages.push(a); steps++;
      for (const r of s.results || []) {
        const text = r.full || r.text || '';
        if (/^(ERROR|DENIED)/.test(text)) errors++;
        messages.push({ role: 'tool', tool_call_id: r.id, name: r.name, content: text }); calls++;
      }
      for (const n of notes) if (n.after === i + 1) messages.push({ role: 'user', content: n.text });
    });
    if (t.final !== undefined && t.final !== null) {
      if (st.length) withState(messages[messages.length - 1], t.finalState && `${t.finalState}\n\nThe user's request, for reference: "${short(t.user, 400)}"`);
      const own = t.modelFinal !== undefined ? t.modelFinal : t.final;
      if (own !== t.final) appended++;
      const a = { role: 'assistant', content: own || '' };
      if (t.finalReasoning) a.reasoning_content = t.finalReasoning;
      messages.push(a); steps++;
    }
  }
  return {
    messages,
    tools: openAITools(specs),
    metadata: { format: FORMAT, source: 'Exoplanet Science Lab assistant', model, protocol, page, created: new Date().toISOString(), turns: turns.length, steps, tool_calls: calls, tool_errors: errors, answers_with_app_table: appended, ...meta },
  };
}
const short = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };

export const toJsonl = (records) => records.map((r) => JSON.stringify(r)).join('\n') + '\n';

/**
 * The turns of a training record, to open an exported conversation again in the chat. The state cards are taken
 * off the user and tool messages; what cannot be told apart (a nudge from the app) stays a note.
 */
export function fromTrainingRecord(rec) {
  if (!rec || !Array.isArray(rec.messages)) throw new Error('not a conversation record: it has no "messages"');
  const turns = []; let t = null, step = null;
  const stripState = (s) => { const i = String(s).indexOf('\n\nCURRENT STATE'); return i >= 0 ? s.slice(0, i) : s; };
  for (const m of rec.messages) {
    if (m.role === 'system') continue;
    if (m.role === 'user') {
      if (/^\[From the app/.test(m.content) && t) { (t.notes = t.notes || []).push({ after: t.steps.length, text: m.content }); continue; }
      const i = m.content.indexOf(REQUEST); t = { user: i >= 0 ? m.content.slice(i + REQUEST.length) : m.content, steps: [], final: null, notes: [] }; turns.push(t); step = null; continue;
    }
    if (!t) continue;
    if (m.role === 'assistant') {
      if (m.tool_calls && m.tool_calls.length) { step = { content: m.content || '', calls: m.tool_calls.map((c) => ({ id: c.id, name: c.function.name, args: safeParse(c.function.arguments) })), results: [] }; if (m.reasoning_content) step.reasoning = m.reasoning_content; t.steps.push(step); }
      else { t.final = m.content || ''; if (m.reasoning_content) t.finalReasoning = m.reasoning_content; }
    } else if (m.role === 'tool' && step) step.results.push({ id: m.tool_call_id, name: m.name || (step.calls.find((c) => c.id === m.tool_call_id) || {}).name, text: stripState(m.content) });
  }
  return turns;
}
const safeParse = (s) => { try { return JSON.parse(s); } catch { return s; } };
