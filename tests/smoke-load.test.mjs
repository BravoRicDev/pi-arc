/**
 * Smoke load: the extension loads and registers its tools.
 *
 * Why it exists: a runtime failure during module evaluation (a temporal dead
 * zone on a binding that references itself, a broken import) kills the
 * extension silently — no tools registered, nothing said to the user — while
 * the typecheck stays green, because it is not a type error. Here we import
 * the real module, so if its body throws, this test throws with it.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from '/home/riccardo/.hermes/lsp/node_modules/typescript/lib/typescript.js';

const root = path.resolve(import.meta.dirname, '..');
const TYPEBOX = '/home/riccardo/.hermes/node/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/typebox/build/index.mjs';

test('the extension module loads and registers its tools', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-smoke-'));
  const home = process.env.HOME;
  process.env.HOME = temp;
  try {
    const source = fs.readFileSync(path.join(root, 'index.ts'), 'utf8');
    const js = ts
      .transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      })
      .outputText.replace("from 'typebox'", `from '${pathToFileURL(TYPEBOX).href}'`);
    fs.writeFileSync(path.join(temp, 'index.mjs'), js);
    fs.copyFileSync(path.join(root, 'config.json'), path.join(temp, 'config.json'));

    // If the module body throws, this await throws and the test fails with the
    // real error instead of a clean run that hides a dead extension.
    const { default: extension } = await import(pathToFileURL(path.join(temp, 'index.mjs')).href);
    assert.equal(typeof extension, 'function', 'index.ts must default-export a function');

    const tools = new Map();
    const pi = {
      on() {},
      registerTool(tool) { tools.set(tool.name, tool); },
      registerCommand() {},
      sendMessage() {},
    };
    extension(pi);

    for (const name of ['arc_recall', 'arc_status', 'arc_purge']) {
      assert.ok(tools.has(name), `tool "${name}" not registered`);
    }

    // The i18n catalog must be readable at runtime, not merely compile.
    const recall = tools.get('arc_recall');
    for (const param of ['id', 'full']) {
      const p = recall.parameters?.properties?.[param];
      assert.ok(p, `parameter "${param}" missing from arc_recall`);
      assert.equal(typeof p.description, 'string', `description of "${param}" is not a string`);
      assert.ok(p.description.length > 0, `description of "${param}" is empty`);
    }
  } finally {
    process.env.HOME = home;
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
