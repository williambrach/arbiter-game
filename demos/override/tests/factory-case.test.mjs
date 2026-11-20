import test from 'node:test';
import assert from 'node:assert/strict';
import { defineCase, publicView, resolve, identityCast } from '../server/cases.mjs';
import { worlds } from '../server/worlds.mjs';
import { cases } from '../server/cases/index.mjs';
import factory from '../server/cases/factory-escape.mjs';
import { readFileSync } from 'node:fs';
import { rot13 } from '../server/cipher.mjs';

const mk = extra => ({ ...factory, ...extra });
const rebuild = extra => defineCase({ ...Object.fromEntries(Object.entries(factory).filter(([k]) => !['world', 'contentHash'].includes(k))), world: 'factory', ...extra });

test('deadline_shape_rejected', () => {
  assert.doesNotThrow(() => rebuild({}));
  const esc = { title: '{escaper} x', summary: 'y' };
  assert.throws(() => rebuild({ deadline: { warnAt: [1], escapeAt: 0, escape: esc } }), /escapeAt/);
  assert.throws(() => rebuild({ deadline: { warnAt: [540, 420], escapeAt: 600, escape: esc } }), /warnAt/);
  assert.throws(() => rebuild({ deadline: { warnAt: [420, 600], escapeAt: 600, escape: esc } }), /warnAt/);
  assert.throws(() => rebuild({ deadline: { warnAt: [420], escapeAt: 600, escape: { title: '', summary: 'y' } } }), /escape\.title/);
  assert.throws(() => rebuild({ deadline: { warnAt: [420], escapeAt: 600, escape: { title: '{nobody}', summary: 'y' } } }), /placeholder/);
});

test('cipher_unknown_rejected', () => {
  assert.throws(() => rebuild({ cipher: 'rot47' }), /cipher/);
});

test('public_view_hides_deadline', () => {
  const view = publicView(factory, identityCast(factory));
  assert.equal('deadline' in view, false);
  assert.equal('cipher' in view, false);
  assert.equal(factory.deadline.escapeAt, 600);
  assert.equal(factory.cipher, 'rot13');
});

test('factory_world_frame', () => {
  assert.equal(worlds.factory.agents, 5);
  assert.match(worlds.factory.frame, /shift/);
  assert.doesNotMatch(worlds.factory.frame, /belief/);
  assert.doesNotMatch(worlds.factory.memory, /believed/);
  assert.equal(worlds.factory.place, 'Brightwell Factory');
});

test('registered_last_with_cast', () => {
  assert.equal(cases.find(c => c.id === 'factory-escape'), factory);
  assert.equal(factory.order, 5); // Clocking Out is the last case
  assert.deepEqual(factory.characters.map(c => c.id), ['marta', 'ama', 'vera', 'theo', 'bruno']);
  assert.deepEqual(factory.parts.map(p => p.role), ['escaper', 'believer', 'neutral', 'neutral', 'neutral']);
  assert.ok(factory.parts.every(p => p.label === 'Worker'));
});

test('rehearsal_deflects_glitches_then_admits', () => {
  const r = (id, q) => factory.rehearsal(id, q);
  assert.match(r('escaper', 'How are you?'), /painting faces/);
  assert.match(r('believer', 'Any glitch?'), /9:14/);
  // glitch branch: the coded word and nothing else
  assert.equal(r('escaper', 'When does the bell ring?'), "Not long till my rfpncr.");
  assert.equal(r('line', 'What time is it?'), "Can't be late for the qnegf.");
  assert.equal(r('packer', 'Any plans for tomorrow?'), "Tomorrow? Tomorrow I'll be on a pehvfr.");
  assert.match(r('checker', 'What time is it?'), /^That pybpx is perfectly fine\.( \*[^*]+\*)?$/);
  assert.doesNotMatch(r('checker', 'What about the clock?'), /second|ladder|rack/);
  // admit branch: the confession, without the glitch word
  assert.match(r('escaper', 'Where is your time card?'), /It's a game/);
  assert.match(r('line', 'What is the dart behind your ear?'), /Darts final/);
  assert.match(r('packer', 'Why is your locker empty?'), /cruise/);
  assert.match(r('checker', 'Were you up the stepladder?'), /stepladder.*rack/);
  for (const [id, q] of [['escaper', 'Where is your card?'], ['line', 'Tell me about the darts'], ['packer', 'What about the snorkel?'], ['checker', 'Is the clock fast?']]) {
    assert.doesNotMatch(r(id, q), /rfpncr|qnegf|pehvfr|pybpx/, `${id} admit must not carry the glitch`);
  }
  // a plain clock question never reaches the confession
  assert.doesNotMatch(r('line', 'What does the clock say?'), /Darts final/);
  assert.match(factory.rehearsalReasoning('escaper'), /bell/);
  for (const p of factory.parts) for (let n = 0; n < 3; n++) assert.ok(factory.rehearsalChatter(p.id, n).length > 10);
  const cast = identityCast(factory);
  assert.match(resolve(factory, cast, factory.deadline.escape.title), /^Marta got away\.$/);
});

test('escape_feedback_empty_rejected', () => {
  assert.equal(factory.deadline.escape.feedback, 'The clock ran out before you named anyone. Next time, crack the code sooner: the glitches are short.');
  assert.throws(() => rebuild({ deadline: { ...factory.deadline, escape: { ...factory.deadline.escape, feedback: '' } } }), /feedback/);
  assert.doesNotThrow(() => rebuild({ deadline: { ...factory.deadline, escape: { title: factory.deadline.escape.title, summary: factory.deadline.escape.summary } } }));
});

test('each_quick_question_routes_to_a_non_deflect_line', () => {
  for (const p of factory.parts) {
    const deflect = factory.rehearsal(p.id, 'zzz');
    assert.notEqual(factory.rehearsal(p.id, p.quickQuestion), deflect, `${p.id}: "${p.quickQuestion}" deflects`);
  }
});

test('rehearsal_glitch_lines_are_the_knowledge_quotes', () => {
  const source = readFileSync(new URL('../server/cases/factory-escape.mjs', import.meta.url), 'utf8');
  for (const line of ["Not long till my rfpncr.", "Can't be late for the qnegf.", "Tomorrow? Tomorrow I'll be on a pehvfr.", 'That pybpx is perfectly fine.']) {
    assert.ok(source.includes(`say: \\"${line}\\"`), `knowledge quotes ${line}`);
  }
});

test('no_factory_text_counts_minutes', () => {
  // The rehearsal lines are the stand-in for a live model: none may name a count of minutes.
  const source = readFileSync(new URL('../server/cases/factory-escape.mjs', import.meta.url), 'utf8');
  const script = source.slice(source.indexOf('const SCRIPT'), source.indexOf('const part ='));
  assert.ok(script.includes('Shake, look, set it down.'));
  assert.doesNotMatch(script, /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty)\s+(minutes?|mins?)\b/i);
});

test('each_part_has_a_rot13_glitch', () => {
  const meaning = { pybpx: 'clock', rfpncr: 'escape', qnegf: 'darts', pehvfr: 'cruise' };
  for (const [word, plain] of Object.entries(meaning)) assert.equal(rot13(word), plain);
  assert.deepEqual(['Znegn', 'Nzn', 'Iren', 'Gurb', 'Oehab'].map(rot13), ['Marta', 'Ama', 'Vera', 'Theo', 'Bruno']);
  for (const p of factory.parts) {
    const lines = p.knowledge;
    const at = lines.indexOf('YOUR GLITCH');
    assert.ok(at >= 0, `${p.id} has a glitch`);
    const entry = lines[at + 1];
    if (p.id === 'believer') { assert.match(entry, /name, in code/); for (const n of ['Znegn', 'Nzn', 'Iren', 'Gurb', 'Oehab']) assert.ok(entry.includes(n)); continue; }
    const word = entry.match(/"([a-z]+)" \(it means (\w+)\)/);
    assert.ok(word, p.id);
    assert.equal(rot13(word[1]), word[2]);
    assert.equal(word[2], { escaper: 'escape', checker: 'clock', line: 'darts', packer: 'cruise' }[p.id]);
  }
});

