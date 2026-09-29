import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import ts from '/home/riccardo/.hermes/lsp/node_modules/typescript/lib/typescript.js';

// Run the REAL extension in a disposable HOME. No LLM, external service or real card is touched.
const root = path.resolve(import.meta.dirname, '..');
const source = fs.readFileSync(path.join(root, 'index.ts'), 'utf8');

async function harness() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-amnesia-test-'));
  const home = process.env.HOME;
  process.env.HOME = temp;
  try {
    const js = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText
      .replace("from 'typebox'", `from '${pathToFileURL('/home/riccardo/.hermes/node/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/typebox/build/index.mjs').href}'`);
    fs.writeFileSync(path.join(temp, 'index.mjs'), js);
    fs.copyFileSync(path.join(root, 'topic-scope.mjs'), path.join(temp, 'topic-scope.mjs'));
    fs.writeFileSync(path.join(temp, 'config.json'), fs.readFileSync(path.join(root, 'config.json')));
    const handlers = new Map();
    const tools = new Map();
    const commands = new Map();
    const messages = [];
    const notifications = [];
    const pi = {
      on(event, handler) { handlers.set(event, handler); },
      registerTool(tool) { tools.set(tool.name, tool); },
      registerCommand(name, command) { commands.set(name, command); },
      sendMessage(message) { messages.push(message); },
    };
    const { default: extension } = await import(pathToFileURL(path.join(temp, 'index.mjs')).href);
    extension(pi);
    const ctx = {
      cwd: temp, hasUI: false, ui: { notify(...args) { notifications.push(args); } }, sessionManager: { getSessionId: () => 'test-session-uuid' },
    };
    await handlers.get('session_start')({ reason: 'startup' }, ctx);
    return { temp, home, handlers, tools, commands, messages, notifications, ctx };
  } catch (error) {
    process.env.HOME = home;
    fs.rmSync(temp, { recursive: true, force: true });
    throw error;
  }
}

function cleanup(h) {
  process.env.HOME = h.home;
  fs.rmSync(h.temp, { recursive: true, force: true });
}

const card = '## Sempre valido\nRuolo dev.\n## Lavoro attivo\nRiparare API pagamenti; prossimo test invoice.\n## Topic: crm\nVecchia campagna CRM.';

// These tests deliberately run serially because HOME is process-global.
test('simultaneous periodic and random review inject the card once without nested labels', async () => {
  const previousRandom = Math.random;
  Math.random = () => 0;
  let h;
  try {
    h = await harness();
    await h.tools.get('carta_memoria').execute('id', { testo: card, ogni_turni: 1 }, undefined, undefined, h.ctx);
    await h.handlers.get('turn_end')();
    const response = await h.handlers.get('context')({ messages: [{ role: 'user', content: 'continua' }] });
    const text = response.messages.at(-1).content;
    assert.match(text, /RIVEDI CARTA/);
    assert.equal(text.match(/Riparare API pagamenti/g)?.length, 1);
    assert.equal(text.match(/\[ANTI-AMNESIA ·/g)?.length, 1);
  } finally { Math.random = previousRandom; if (h) cleanup(h); }
});

test('archived topics require the current turn prompt, never a historical user message', async () => {
  const h = await harness();
  try {
    await h.tools.get('carta_memoria').execute('id', { testo: card }, undefined, undefined, h.ctx);
    await h.handlers.get('session_start')({ reason: 'resume' }, h.ctx);
    const historical = [{ role: 'user', content: 'CRM' }, { role: 'assistant', content: 'Vecchia risposta' }];
    const resumed = await h.handlers.get('context')({ messages: historical });
    assert.doesNotMatch(resumed.messages.at(-1).content, /Vecchia campagna CRM/);
    await h.handlers.get('before_agent_start')({ prompt: 'CRM', systemPrompt: 'SYS', systemPromptOptions: { cwd: h.temp } });
    await h.commands.get('carta').handler('ora', h.ctx);
    const current = await h.handlers.get('context')({ messages: historical });
    assert.match(current.messages.at(-1).content, /Vecchia campagna CRM/);
    await h.handlers.get('agent_settled')();
    await h.commands.get('carta').handler('ora', h.ctx);
    const settled = await h.handlers.get('context')({ messages: historical });
    assert.doesNotMatch(settled.messages.at(-1).content, /Vecchia campagna CRM/);
    await h.handlers.get('before_agent_start')({ prompt: 'continua', systemPrompt: 'SYS', systemPromptOptions: { cwd: h.temp } });
    await h.commands.get('carta').handler('ora', h.ctx);
    const unrelated = await h.handlers.get('context')({ messages: historical });
    assert.doesNotMatch(unrelated.messages.at(-1).content, /Vecchia campagna CRM/);
  } finally { cleanup(h); }
});

test('interval validation rejects ineffective values and rearms random review', async () => {
  const h = await harness();
  try {
    const tool = h.tools.get('carta_memoria');
    const invalid = await tool.execute('id', { testo: card, ogni_turni: 1001 }, undefined, undefined, h.ctx);
    assert.equal(invalid.details.error, 'intervallo-non-valido');
    assert.equal(fs.existsSync(path.join(h.temp, '.pi/anti-amnesia/cards/test-session-uuid.md')), false);
    await tool.execute('id', { testo: card }, undefined, undefined, h.ctx);
    await h.commands.get('carta').handler('ogni 1001', h.ctx);
    assert.match(h.notifications.at(-1)[0], /N fra 1 e 1000/);
    await h.commands.get('carta').handler('ogni 1', h.ctx);
    await h.handlers.get('turn_end')();
    await h.handlers.get('turn_end')();
    const refresh = await h.handlers.get('context')({ messages: [{ role: 'user', content: 'continua' }] });
    assert.match(refresh.messages.at(-1).content, /RIVEDI CARTA/);
  } finally { cleanup(h); }
});

test('bootstrap retries replace earlier persisted bootstrap prompts instead of accumulating', async () => {
  const h = await harness();
  try {
    await h.handlers.get('before_agent_start')({ prompt: 'continua', systemPrompt: 'SYS', systemPromptOptions: { cwd: h.temp } });
    const old = { role: 'custom', customType: 'anti-amnesia-bootstrap', content: 'OLD BOOTSTRAP' };
    const recent = { ...old, content: 'RECENT BOOTSTRAP' };
    const input = [{ role: 'user', content: 'continua' }, old, recent];
    const cleaned = await h.handlers.get('context')({ messages: input });
    assert.deepEqual(cleaned.messages, [input[0], recent]);
    for (let i = 0; i < 15; i++) await h.handlers.get('turn_end')();
    const retry = await h.handlers.get('context')({ messages: input });
    assert.equal(retry.messages.filter((m) => m.customType === 'anti-amnesia-bootstrap').length, 1);
    assert.doesNotMatch(JSON.stringify(retry.messages), /OLD BOOTSTRAP|RECENT BOOTSTRAP/);
  } finally { cleanup(h); }
});

test('a busy registry lock fails explicitly without replacing another writer', async () => {
  const h = await harness();
  try {
    const lockPath = path.join(h.temp, '.pi/anti-amnesia/registry.json.lock');
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, '999999\n');
    const blocked = await h.tools.get('carta_memoria').execute('id', { testo: card }, undefined, undefined, h.ctx);
    assert.equal(blocked.details.error, 'registro-fallito');
    assert.equal(fs.readFileSync(lockPath, 'utf8'), '999999\n');
    fs.unlinkSync(lockPath);
    const retried = await h.tools.get('carta_memoria').execute('retry', { testo: card }, undefined, undefined, h.ctx);
    assert.equal(retried.details.ok, true);
  } finally { cleanup(h); }
});

test('concurrent processes preserve both session entries in the registry', async () => {
  const h = await harness();
  try {
    const workerPath = path.join(h.temp, 'registry-worker.mjs');
    fs.writeFileSync(workerPath, `import extension from './index.mjs';
const handlers = new Map(); let tool;
const pi = { on: (name, fn) => handlers.set(name, fn), registerTool: (entry) => { if (entry.name === 'carta_memoria') tool = entry; }, registerCommand() {} };
extension(pi);
const ctx = { cwd: process.env.HOME, hasUI: false, sessionManager: { getSessionId: () => process.argv[2] } };
await handlers.get('session_start')({ reason: 'startup' }, ctx);
for (let i = 0; i < 8; i++) {
  const result = await tool.execute('id', { testo: '## Lavoro attivo\\nTask ' + process.argv[2] + ' #' + i }, undefined, undefined, ctx);
  if (!result.details.ok) throw new Error(JSON.stringify(result.details));
}`);
    const launch = (id) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [workerPath, id], { env: { ...process.env, HOME: h.temp } });
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`${id}: ${stderr}`)));
    });
    await Promise.all([launch('session-one'), launch('session-two')]);
    const registry = JSON.parse(fs.readFileSync(path.join(h.temp, '.pi/anti-amnesia/registry.json'), 'utf8'));
    assert.ok(registry.cards['session-one']);
    assert.ok(registry.cards['session-two']);
    assert.equal(fs.existsSync(path.join(h.temp, '.pi/anti-amnesia/registry.json.lock')), false);
  } finally { cleanup(h); }
});

test('first prompt bootstraps, a saved card survives short prompts and an immediate compaction retry', async () => {
  const h = await harness();
  try {
    const before = h.handlers.get('before_agent_start');
    const context = h.handlers.get('context');
    const first = await before({ prompt: 'continua', systemPrompt: 'SYS', systemPromptOptions: { cwd: h.temp } });
    assert.match(first.message.content, /BOOTSTRAP/);
    const saved = await h.tools.get('carta_memoria').execute('id', { testo: card, ruolo: 'dev' }, undefined, undefined, h.ctx);
    assert.equal(saved.details.ok, true);
    assert.equal(h.messages.length, 0);
    const input = [{ role: 'user', content: 'continua' }];
    const next = await context({ messages: input });
    assert.equal(next, undefined); // no scheduled reminder yet
    await h.handlers.get('session_compact')({ reason: 'overflow' }, h.ctx);
    const retry = await context({ messages: input });
    assert.match(retry.messages.at(-1).content, /Riparare API pagamenti/);
    assert.doesNotMatch(retry.messages.at(-1).content, /Vecchia campagna CRM/);
    assert.equal(h.messages.length, 0); // no delayed nextTurn injection
    assert.equal(await context({ messages: input }), undefined); // one shot
  } finally { cleanup(h); }
});

test('checkpoint update replaces only current work and preserves archived notes', async () => {
  const h = await harness();
  try {
    const tool = h.tools.get('carta_memoria');
    assert.equal((await tool.execute('a', { testo: card }, undefined, undefined, h.ctx)).details.ok, true);
    const updated = await tool.execute('b', { lavoro_attivo: 'Obiettivo: pagamenti; test refund ora.' }, undefined, undefined, h.ctx);
    assert.equal(updated.details.ok, true);
    const saved = fs.readFileSync(path.join(h.temp, '.pi/anti-amnesia/cards/test-session-uuid.md'), 'utf8');
    assert.match(saved, /test refund ora/);
    assert.doesNotMatch(saved, /prossimo test invoice/);
    assert.match(saved, /Vecchia campagna CRM/);
    assert.equal(fs.existsSync(path.join(h.temp, '.pi/anti-amnesia/cards/test-session-uuid.md.tmp')), false);
  } finally { cleanup(h); }
});

test('a resumed card is delivered on the very first autonomous LLM call', async () => {
  const h = await harness();
  try {
    await h.tools.get('carta_memoria').execute('id', { testo: card }, undefined, undefined, h.ctx);
    await h.handlers.get('session_start')({ reason: 'resume' }, h.ctx);
    const first = await h.handlers.get('context')({ messages: [{ role: 'user', content: 'continua' }] });
    assert.match(first.messages.at(-1).content, /ripresa sessione/);
    assert.match(first.messages.at(-1).content, /prossimo test invoice/);
    assert.doesNotMatch(first.messages.at(-1).content, /Vecchia campagna CRM/);
    assert.equal(await h.handlers.get('context')({ messages: [{ role: 'user', content: 'continua' }] }), undefined);
  } finally { cleanup(h); }
});

test('reload refreshes the ESM helper rather than keeping a stale cached copy', async () => {
  const h = await harness();
  try {
    const helper = path.join(h.temp, 'topic-scope.mjs');
    await h.tools.get('carta_memoria').execute('id', { testo: card }, undefined, undefined, h.ctx);
    const old = fs.readFileSync(helper, 'utf8');
    assert.match(old, /const selected = \[\.\.\.scope\.always, \.\.\.scope\.active\];/);
    fs.writeFileSync(helper, old.replace(
      'const selected = [...scope.always, ...scope.active];',
      "const selected = [...scope.always, ...scope.active, 'HELPER UPDATED'];",
    ));
    await h.handlers.get('session_start')({ reason: 'reload' }, h.ctx);
    const fresh = await h.handlers.get('context')({ messages: [{ role: 'user', content: 'continua' }] });
    assert.match(fresh.messages.at(-1).content, /HELPER UPDATED/);
  } finally { cleanup(h); }
});

test('missing card retries bootstrap instead of silently disabling recovery', async () => {
  const h = await harness();
  try {
    const before = h.handlers.get('before_agent_start');
    const options = { prompt: 'continua', systemPrompt: 'SYS', systemPromptOptions: { cwd: h.temp } };
    assert.match((await before(options)).message.content, /BOOTSTRAP/);
    assert.equal(await before(options), undefined);
    for (let i = 0; i < 15; i++) await h.handlers.get('turn_end')();
    const autonomous = await h.handlers.get('context')({ messages: [{ role: 'user', content: 'continua' }] });
    assert.match(autonomous.messages.at(-1).content, /BOOTSTRAP/);
    assert.equal(await before(options), undefined); // no duplicate on the next model request
  } finally { cleanup(h); }
});

test('regenerate archives old card and resume cannot resurrect it', async () => {
  const h = await harness();
  try {
    const file = path.join(h.temp, '.pi/anti-amnesia/cards/test-session-uuid.md');
    await h.tools.get('carta_memoria').execute('id', { testo: card }, undefined, undefined, h.ctx);
    await h.commands.get('carta').handler('rigenera', h.ctx);
    assert.equal(fs.existsSync(file), false);
    assert.equal(fs.readFileSync(`${file}.bak`, 'utf8'), card);
    await h.handlers.get('session_start')({ reason: 'resume' }, h.ctx);
    const boot = await h.handlers.get('before_agent_start')({ prompt: 'continua', systemPrompt: 'SYS', systemPromptOptions: { cwd: h.temp } });
    assert.match(boot.message.content, /BOOTSTRAP/);
    const old = { role: 'custom', customType: 'anti-amnesia', content: 'OLD WRONG TASK' };
    const context = await h.handlers.get('context')({ messages: [{ role: 'user', content: 'nuovo compito' }, old] });
    assert.deepEqual(context.messages, [{ role: 'user', content: 'nuovo compito' }]);
  } finally { cleanup(h); }
});

test('explicit shared draft never enters model as active memory', async () => {
  const h = await harness();
  try {
    const draftPath = path.join(h.temp, 'PiAgent/prompts/carta-anti-amnesia.md');
    fs.mkdirSync(path.dirname(draftPath), { recursive: true });
    fs.writeFileSync(draftPath, 'BOZZA DA PERSONALIZZARE');
    await h.commands.get('carta').handler('bootstrap', h.ctx);
    const first = await h.handlers.get('before_agent_start')({ prompt: 'ok', systemPrompt: 'SYS', systemPromptOptions: { cwd: h.temp } });
    assert.match(first.message.content, /BOOTSTRAP/);
    assert.equal(await h.handlers.get('context')({ messages: [{ role: 'user', content: 'ok' }] }), undefined);
  } finally { cleanup(h); }
});

test('failed registry write is reported without corrupting the saved card', async () => {
  const h = await harness();
  try {
    const registry = path.join(h.temp, '.pi/anti-amnesia/registry.json');
    fs.mkdirSync(registry, { recursive: true }); // rename over directory must fail
    const result = await h.tools.get('carta_memoria').execute('id', { testo: card }, undefined, undefined, h.ctx);
    assert.equal(result.details.ok, false);
    assert.equal(result.details.error, 'registro-fallito');
    assert.equal(result.details.cartaSalvata, true);
    await h.commands.get('carta').handler('ogni 4', h.ctx);
    assert.match(h.notifications.at(-2)[0], /Registro non salvabile/);
    assert.equal(fs.readFileSync(path.join(h.temp, '.pi/anti-amnesia/cards/test-session-uuid.md'), 'utf8'), card);
    assert.deepEqual(fs.readdirSync(path.dirname(registry)).filter((name) => name.includes('.tmp')), []);
  } finally { cleanup(h); }
});

test('delete blocks traversal and invalidates the active memory', async () => {
  const h = await harness();
  try {
    const sentinel = path.join(h.temp, '.pi/foreign.md');
    fs.writeFileSync(sentinel, 'must survive');
    await h.tools.get('carta_memoria').execute('id', { testo: card }, undefined, undefined, h.ctx);
    await h.commands.get('carta').handler('delete ../../foreign', h.ctx);
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'must survive');
    await h.commands.get('carta').handler('delete test-session-uuid', h.ctx);
    assert.equal(fs.existsSync(path.join(h.temp, '.pi/anti-amnesia/cards/test-session-uuid.md')), false);
    const bootstrap = await h.handlers.get('before_agent_start')({ prompt: 'continua', systemPrompt: 'SYS', systemPromptOptions: { cwd: h.temp } });
    assert.match(bootstrap.message.content, /BOOTSTRAP/);
    assert.equal((await h.tools.get('carta_memoria').execute('read', {}, undefined, undefined, h.ctx)).details.chars, 0);
  } finally { cleanup(h); }
});

test('purge invalidates an old active card and never interprets unsafe registry keys as paths', async () => {
  const h = await harness();
  try {
    await h.tools.get('carta_memoria').execute('id', { testo: card }, undefined, undefined, h.ctx);
    const registry = path.join(h.temp, '.pi/anti-amnesia/registry.json');
    const data = JSON.parse(fs.readFileSync(registry, 'utf8'));
    data.cards['test-session-uuid'].updatedAt = Date.now() - 7200_000;
    data.cards['../../foreign'] = { ...data.cards['test-session-uuid'] };
    fs.writeFileSync(registry, JSON.stringify(data));
    await h.commands.get('carta').handler('purge 1', h.ctx);
    assert.equal(fs.existsSync(path.join(h.temp, '.pi/anti-amnesia/cards/test-session-uuid.md')), false);
    assert.equal((await h.tools.get('carta_memoria').execute('read', {}, undefined, undefined, h.ctx)).details.chars, 0);
  } finally { cleanup(h); }
});

test('unknown structured headings do not leak into active checkpoint injections', async () => {
  const h = await harness();
  try {
    const mixed = '## Sempre valido\nRuolo dev\n## Lavoro attivo\nProssimo test invoice\n## Dettagli clienti\nNon diffondere il contatto';
    await h.tools.get('carta_memoria').execute('id', { testo: mixed }, undefined, undefined, h.ctx);
    for (let i = 0; i < 5; i++) await h.handlers.get('turn_end')();
    const heartbeat = await h.handlers.get('context')({ messages: [{ role: 'user', content: 'continua' }] });
    assert.match(heartbeat.messages.at(-1).content, /Prossimo test invoice/);
    assert.doesNotMatch(heartbeat.messages.at(-1).content, /Non diffondere il contatto/);
  } finally { cleanup(h); }
});

test('old persistent card messages are removed from model context and manual refresh is fresh', async () => {
  const h = await harness();
  try {
    await h.tools.get('carta_memoria').execute('id', { testo: card }, undefined, undefined, h.ctx);
    const old = { role: 'custom', customType: 'anti-amnesia', content: 'OLD WRONG TASK' };
    const input = [{ role: 'user', content: 'continua' }, old];
    const cleaned = await h.handlers.get('context')({ messages: input });
    assert.deepEqual(cleaned.messages, [input[0]]);
    await h.commands.get('carta').handler('ora', h.ctx);
    const refreshed = await h.handlers.get('context')({ messages: input });
    assert.doesNotMatch(JSON.stringify(refreshed.messages), /OLD WRONG TASK/);
    assert.match(refreshed.messages.at(-1).content, /Riparare API pagamenti/);
    assert.equal(h.messages.length, 0);
  } finally { cleanup(h); }
});

test('short autonomous heartbeat repeats active checkpoint before the full refresh', async () => {
  const h = await harness();
  try {
    await h.tools.get('carta_memoria').execute('id', { testo: card }, undefined, undefined, h.ctx);
    for (let i = 0; i < 5; i++) await h.handlers.get('turn_end')();
    const heartbeat = await h.handlers.get('context')({ messages: [{ role: 'user', content: 'ok' }] });
    assert.match(heartbeat.messages.at(-1).content, /CHECKPOINT LAVORO ATTIVO/);
    assert.match(heartbeat.messages.at(-1).content, /prossimo test invoice/);
    assert.doesNotMatch(heartbeat.messages.at(-1).content, /Vecchia campagna CRM/);
    assert.equal(await h.handlers.get('context')({ messages: [{ role: 'user', content: 'ok' }] }), undefined);
  } finally { cleanup(h); }
});

test('scheduled refresh and review run without fresh user keywords', async () => {
  const h = await harness();
  try {
    await h.tools.get('carta_memoria').execute('id', { testo: card, ogni_turni: 1 }, undefined, undefined, h.ctx);
    await h.handlers.get('turn_end')();
    const next = await h.handlers.get('context')({ messages: [{ role: 'user', content: 'ok' }] });
    assert.match(next.messages.at(-1).content, /refresh periodico/);
    assert.match(next.messages.at(-1).content, /prossimo test invoice/);
    assert.doesNotMatch(next.messages.at(-1).content, /Vecchia campagna CRM/);
    await h.handlers.get('turn_end')(); // target casuale fra 1 e 2 turni
    const review = await h.handlers.get('context')({ messages: [{ role: 'user', content: 'continua' }] });
    assert.match(review.messages.at(-1).content, /RIVEDI CARTA/);
    assert.match(review.messages.at(-1).content, /prossimo test invoice/);
  } finally { cleanup(h); }
});
