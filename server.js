#!/usr/bin/env node
// Voice Claude — a tiny local server that lists your Claude Code sessions, resumes any of
// them in headless mode, and streams the output to a browser page that handles speech.
// Zero dependencies: only Node's standard library.

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const PORT = Number(process.env.PORT || 4317);
const DEFAULT_DIR = path.resolve(process.argv[2] || process.env.CLAUDE_CWD || os.homedir());
const PERMISSION_MODE = process.env.CLAUDE_PERMISSION_MODE || 'auto';
const MODEL = process.env.CLAUDE_MODEL || '';
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const CLAUDE_HOME = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const PROJECTS_DIR = path.join(CLAUDE_HOME, 'projects');
const STATE_FILE = path.join(__dirname, 'state.json');
const INDEX = path.join(__dirname, 'public', 'index.html');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Appended to Claude Code's system prompt so answers sound good read aloud.
const VOICE_PROMPT =
  'The user is talking to you by voice and hears your replies through text-to-speech. ' +
  'Their words were transcribed by speech recognition, so expect small transcription errors and interpret generously. ' +
  'Write your prose to be spoken: short, conversational sentences, no tables, minimal markdown. ' +
  'Give short spoken progress updates as you work. Keep code, paths and long output in tool calls or code blocks.';

// ---------- app state (which sessions are hidden from the home page) ----------
function loadState() {
  try { return { hidden: [], ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) }; } catch { return { hidden: [] }; }
}
function saveState(state) { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); }

// ---------- reading Claude Code's session transcripts ----------
function readRecords(file) {
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch { /* partial line while being written */ }
  }
  return out;
}

// The typed text of a user record, or null for tool results, slash commands and injected context.
function promptText(rec) {
  if (rec.type !== 'user' || rec.isMeta || rec.isSidechain) return null;
  const c = rec.message?.content;
  let text = typeof c === 'string' ? c
    : Array.isArray(c) && !c.some((b) => b.type === 'tool_result') ? c.filter((b) => b.type === 'text').map((b) => b.text).join('\n')
    : '';
  text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
  if (!text || /^<(command-|local-command|bash-)/.test(text) || /^(Caveat:|\[Request interrupted)/.test(text)) return null;
  return text;
}

function toolDetail(input = {}) {
  if (Array.isArray(input.questions)) return input.questions.map((q) => q.question).join(' / ').slice(0, 160);
  const pick = input.description || input.command || input.file_path || input.path ||
    input.pattern || input.url || input.query || input.prompt || '';
  return String(pick).split('\n')[0].slice(0, 160);
}

const summaryCache = new Map(); // file -> { key, summary }
function summarize(file) {
  const st = fs.statSync(file);
  const key = `${st.mtimeMs}:${st.size}`;
  const hit = summaryCache.get(file);
  if (hit && hit.key === key) return hit.summary;

  let cwd = null, customTitle = null, aiTitle = null, firstPrompt = null, lastPrompt = null, prompts = 0;
  for (const rec of readRecords(file)) {
    if (!cwd && rec.cwd) cwd = rec.cwd;
    if (rec.type === 'custom-title' && rec.customTitle) customTitle = rec.customTitle;
    if (rec.type === 'ai-title' && rec.aiTitle) aiTitle = rec.aiTitle;
    const text = promptText(rec);
    if (text) { prompts++; firstPrompt ||= text; lastPrompt = text; }
  }
  const summary = prompts === 0 ? null : {
    id: path.basename(file, '.jsonl'),
    cwd,
    title: (customTitle || aiTitle || firstPrompt).split('\n')[0].slice(0, 120),
    lastPrompt: lastPrompt.replace(/\s+/g, ' ').slice(0, 200),
    prompts,
    updated: st.mtimeMs,
  };
  summaryCache.set(file, { key, summary });
  return summary;
}

function allSessions() {
  const list = [];
  let dirs = [];
  try { dirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch {}
  for (const d of dirs) {
    const dir = path.join(PROJECTS_DIR, d.name);
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.jsonl') || !UUID.test(f.slice(0, -6))) continue;
      try {
        const s = summarize(path.join(dir, f));
        if (s && s.cwd) list.push({ ...s, file: path.join(dir, f) });
      } catch { /* unreadable file */ }
    }
  }
  return list.sort((a, b) => b.updated - a.updated);
}

function findSession(id) { return allSessions().find((s) => s.id === id) || null; }

// Past conversation, trimmed to what matters on screen.
function history(file, limit = 120) {
  const items = [];
  for (const rec of readRecords(file)) {
    if (rec.isSidechain) continue;
    const text = promptText(rec);
    if (text) { items.push({ role: 'user', text }); continue; }
    if (rec.type === 'assistant') {
      for (const b of rec.message?.content || []) {
        if (b.type === 'text' && b.text.trim()) items.push({ role: 'assistant', text: b.text });
        else if (b.type === 'tool_use') items.push({ role: 'tool', name: b.name, detail: toolDetail(b.input) });
      }
    }
  }
  // Start the window at a user turn so it doesn't open mid-answer.
  let start = Math.max(0, items.length - limit);
  while (start > 0 && items[start].role !== 'user') start--;
  return items.slice(start);
}

// ---------- running Claude Code ----------
let current = null; // the running claude child process, if any

// Permission prompts and questions Claude is waiting on, keyed by control request id.
const pending = new Map(); // requestId -> { child, send, kind, input, suggestions, toolUseId }

function cancelCurrent() {
  if (!current) return;
  current.cancelled = true;
  current.kill('SIGINT');
}

function ask({ text, sessionId, cwd }, res) {
  cancelCurrent();

  // stream-json input + --permission-prompt-tool stdio lets Claude Code route permission
  // prompts and AskUserQuestion to us as control requests, like the Agent SDK does.
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--include-partial-messages', '--permission-prompt-tool', 'stdio',
    '--permission-mode', PERMISSION_MODE, '--append-system-prompt', VOICE_PROMPT];
  if (sessionId) args.push('--resume', sessionId);
  if (MODEL) args.push('--model', MODEL);

  const child = spawn(CLAUDE_BIN, args, { cwd, env: process.env });
  current = child;
  child.userDenied = new Set(); // tool_use ids the user said no to (not "blocked by permissions")
  const write = (obj) => { if (child.stdin.writable) child.stdin.write(JSON.stringify(obj) + '\n'); };
  child.write = write;
  child.stdin.on('error', () => {});
  write({ type: 'control_request', request_id: randomUUID(), request: { subtype: 'initialize' } });
  write({ type: 'user', message: { role: 'user', content: text } });

  res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache' });
  const send = (obj) => { if (!res.writableEnded) res.write(JSON.stringify(obj) + '\n'); };

  const onControlRequest = (msg) => {
    const r = msg.request || {};
    if (r.subtype !== 'can_use_tool') {
      write({ type: 'control_response', response: { subtype: 'error', request_id: msg.request_id, error: `unsupported: ${r.subtype}` } });
      return;
    }
    const isQuestion = r.tool_name === 'AskUserQuestion';
    pending.set(msg.request_id, {
      child, send, kind: isQuestion ? 'question' : 'permission',
      input: r.input || {}, suggestions: r.permission_suggestions || null, toolUseId: r.tool_use_id,
    });
    if (isQuestion) {
      send({ type: 'question', requestId: msg.request_id, questions: r.input?.questions || [] });
    } else {
      send({
        type: 'permission', requestId: msg.request_id, tool: r.tool_name,
        description: r.description || '', detail: toolDetail(r.input), input: r.input,
        canAlways: Array.isArray(r.permission_suggestions) && r.permission_suggestions.length > 0,
      });
    }
  };

  let buf = '';
  let stderr = '';
  let gotResult = false;
  let blockType = null;

  const handle = (msg) => {
    if (msg.type === 'control_request') return onControlRequest(msg);
    if (msg.type === 'control_cancel_request') {
      pending.delete(msg.request_id);
      return send({ type: 'prompt_cancel', requestId: msg.request_id });
    }
    if (msg.parent_tool_use_id) return; // ignore sub-agent chatter
    switch (msg.type) {
      case 'system':
        if (msg.subtype === 'init') send({ type: 'session', id: msg.session_id, cwd: msg.cwd, model: msg.model });
        break;
      case 'stream_event': {
        const ev = msg.event || {};
        if (ev.type === 'content_block_start') {
          blockType = ev.content_block?.type;
          if (blockType === 'thinking') send({ type: 'status', text: 'Thinking…' });
        } else if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
          send({ type: 'text', text: ev.delta.text });
        } else if (ev.type === 'content_block_stop') {
          if (blockType === 'text') send({ type: 'text_end' });
          blockType = null;
        }
        break;
      }
      case 'assistant':
        for (const block of msg.message?.content || []) {
          if (block.type === 'tool_use') send({ type: 'tool', name: block.name, detail: toolDetail(block.input) });
        }
        break;
      case 'result':
        gotResult = true;
        child.stdin.end(); // no more turns on this process; let it exit
        if (child.cancelled) { send({ type: 'done', ok: false, cancelled: true }); break; }
        send({
          type: 'done',
          ok: !msg.is_error,
          error: msg.is_error ? (msg.result || msg.subtype) : null,
          cost: msg.total_cost_usd,
          durationMs: msg.duration_ms,
          denials: (msg.permission_denials || []).filter((d) => !child.userDenied.has(d.tool_use_id)).map((d) => `${d.tool_name}: ${toolDetail(d.tool_input)}`),
        });
        break;
    }
  };

  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try { handle(JSON.parse(line)); } catch { /* ignore non-JSON lines */ }
    }
  });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('error', (err) => {
    send({ type: 'done', ok: false, error: `Could not start "${CLAUDE_BIN}": ${err.message}` });
    res.end();
  });
  child.on('close', (code, signal) => {
    if (current === child) current = null;
    for (const [id, p] of pending) if (p.child === child) pending.delete(id);
    if (!gotResult) {
      send(signal || child.cancelled
        ? { type: 'done', ok: false, cancelled: true }
        : { type: 'done', ok: false, error: stderr.trim() || `claude exited with code ${code}` });
    }
    res.end();
  });
  // Browser went away (e.g. user interrupted): stop the run.
  res.on('close', () => { if (!res.writableFinished && current === child) cancelCurrent(); });
}

// ---------- HTTP ----------
function readJson(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch { resolve({}); } });
  });
}

const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

const server = http.createServer(async (req, res) => {
  const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  const url = new URL(req.url, 'http://localhost');
  const route = `${req.method} ${url.pathname}`;
  let m;

  // The page can run arbitrary Claude Code turns, so reject cross-site requests.
  const origin = req.headers.origin;
  if (origin && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return json(403, { error: 'forbidden' });

  try {
    if (route === 'GET /' || route === 'GET /index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return fs.createReadStream(INDEX).pipe(res);
    }
    if (route === 'GET /api/sessions') {
      const hidden = new Set(loadState().hidden);
      const sessions = allSessions().map(({ file, ...s }) => ({ ...s, hidden: hidden.has(s.id) }));
      return json(200, { sessions, defaultDir: DEFAULT_DIR, home: os.homedir(), permissionMode: PERMISSION_MODE });
    }
    if (req.method === 'GET' && (m = url.pathname.match(/^\/api\/sessions\/([0-9a-f-]{36})$/i))) {
      const s = findSession(m[1]);
      if (!s) return json(404, { error: 'session not found' });
      const { file, ...meta } = s;
      return json(200, { ...meta, messages: history(file) });
    }
    if (req.method === 'POST' && (m = url.pathname.match(/^\/api\/sessions\/([0-9a-f-]{36})\/(hide|unhide)$/i))) {
      const state = loadState();
      state.hidden = state.hidden.filter((id) => id !== m[1]);
      if (m[2] === 'hide') state.hidden.push(m[1]);
      saveState(state);
      return json(200, { ok: true });
    }
    if (route === 'POST /api/ask') {
      const { text, sessionId, cwd } = await readJson(req);
      if (!text || !String(text).trim()) return json(400, { error: 'empty prompt' });
      if (sessionId) {
        // Resume in the session's own directory; Claude Code looks sessions up per project.
        const s = UUID.test(sessionId) && findSession(sessionId);
        if (!s) return json(404, { error: 'session not found' });
        if (!isDir(s.cwd)) return json(400, { error: `directory no longer exists: ${s.cwd}` });
        return ask({ text: String(text), sessionId, cwd: s.cwd }, res);
      }
      const dir = path.resolve(String(cwd || DEFAULT_DIR).replace(/^~(?=$|\/)/, os.homedir()));
      if (!isDir(dir)) return json(400, { error: `not a directory: ${dir}` });
      return ask({ text: String(text), cwd: dir }, res);
    }
    if (route === 'POST /api/respond') {
      const { requestId, allow, always, message, answers } = await readJson(req);
      const p = pending.get(requestId);
      if (!p) return json(404, { error: 'this prompt is no longer waiting for an answer' });
      pending.delete(requestId);
      let response;
      if (p.kind === 'question') {
        response = { behavior: 'allow', updatedInput: { ...p.input, answers: answers || {} } };
      } else if (allow) {
        response = { behavior: 'allow', updatedInput: p.input };
        if (always && p.suggestions) response.updatedPermissions = p.suggestions;
      } else {
        p.child.userDenied.add(p.toolUseId);
        response = { behavior: 'deny', message: message
          ? `The user declined this and said: "${message}"`
          : 'The user declined this action.' };
      }
      p.child.write({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } });
      return json(200, { ok: true });
    }
    if (route === 'POST /api/cancel') {
      cancelCurrent();
      return json(200, { ok: true });
    }
    json(404, { error: 'not found' });
  } catch (err) {
    json(500, { error: err.message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://localhost:${PORT}`;
  console.log(`Voice Claude running at ${url}`);
  console.log(`  sessions from:   ${PROJECTS_DIR}`);
  console.log(`  permission mode: ${PERMISSION_MODE}`);
  if (process.env.NO_OPEN !== '1') execFile('open', [url], () => {});
});
