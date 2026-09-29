import assert from 'node:assert/strict';
import test from 'node:test';
import { extractLatestUserText, replaceActiveCheckpoint, selectCardForTopic } from '../topic-scope.mjs';

const card = [
  '## Sempre valido',
  'Ruolo developer, rileggi /home/riccardo/PiAgent/prompts/base.md.',
  '## Lavoro attivo',
  'Obiettivo: riparare API pagamenti. Prossimo passo: eseguire test invoice.',
  '## Topic: newsletter, CRM',
  'Storico CRM: vecchio bridge newsletter, non è il lavoro attivo.',
].join('\n');

test('autonomous continuation keeps current objective and next step with no keywords', () => {
  for (const prompt of ['continua', 'ok', '', 'vai avanti']) {
    const result = selectCardForTopic(card, prompt);
    assert.match(result.text, /Prossimo passo: eseguire test invoice/);
    assert.match(result.text, /Ruolo developer/);
    assert.doesNotMatch(result.text, /Storico CRM/);
    assert.equal(result.hasActive, true);
  }
});

test('explicit archived topic adds only its own section', () => {
  const result = selectCardForTopic(card, 'Riprendiamo il CRM');
  assert.match(result.text, /Storico CRM/);
  assert.match(result.text, /API pagamenti/);
  assert.equal(result.topicMatched, true);
});

test('unrelated user question never wakes archived notes', () => {
  const result = selectCardForTopic(card, 'Scrivi una poesia per mia sorella');
  assert.doesNotMatch(result.text, /Storico CRM/);
});

test('existing unstructured session cards still survive sparse prompts', () => {
  const legacy = 'Debug del bridge newsletter nel CRM: test ancora da eseguire.';
  const result = selectCardForTopic(legacy, 'continua');
  assert.match(result.text, /test ancora da eseguire/);
  assert.equal(result.legacy, true);
});

test('legacy-only cards survive, but unknown headings cannot leak into active work', () => {
  const original = '# Carta\n## 1. CHI SONO\nDeveloper\n## 2. STATO\nTest da eseguire';
  assert.equal(selectCardForTopic(original, 'ok').text, original);
  const structured = '# Carta\n## Sempre valido\nRuolo dev\n## Lavoro attivo\nProssimo passo\n## Dettagli\nPath da leggere';
  const result = selectCardForTopic(structured, 'continua');
  assert.match(result.text, /# Carta/);
  assert.doesNotMatch(result.text, /Path da leggere/);
  assert.deepEqual(result.unclassified, ['Dettagli']);
});

test('checkpoint update accepts the descriptive heading recommended by bootstrap', () => {
  const original = '## Sempre valido\nRuolo dev\n## Lavoro attivo — obiettivo e prossimo passo\nVecchio task\n## Dettagli\nNote archiviate';
  const updated = replaceActiveCheckpoint(original, 'Nuovo task');
  assert.match(updated, /## Lavoro attivo — obiettivo e prossimo passo\nNuovo task/);
  assert.doesNotMatch(updated, /Vecchio task/);
  assert.match(updated, /## Dettagli\nNote archiviate/);
});

test('checkpoint update preserves rules and archived notes verbatim', () => {
  const updated = replaceActiveCheckpoint(card, 'Obiettivo: fatture; prossimo passo: test refund.');
  assert.match(updated, /test refund/);
  assert.doesNotMatch(updated, /test invoice/);
  assert.match(updated, /Ruolo developer/);
  assert.match(updated, /Storico CRM/);
  assert.throws(() => replaceActiveCheckpoint('## Sempre valido\nsolo ruolo', 'nuovo'), /esattamente una sezione/);
});

test('latest user text ignores assistant and tool messages', () => {
  const messages = [
    { role: 'user', content: 'Richiesta iniziale' },
    { role: 'assistant', content: 'Risposta' },
    { role: 'toolResult', content: 'output tool' },
    { role: 'user', content: [{ type: 'text', text: 'Nuova richiesta' }] },
  ];
  assert.equal(extractLatestUserText(messages), 'Nuova richiesta');
});
