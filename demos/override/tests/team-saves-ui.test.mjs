import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hudShell, practiceTag } from '../client/hud.ts';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const main = read('../client/main.ts');

test('practice_tag: shown only for a practice session', () => {
  assert.equal(practiceTag(false), '');
  assert.match(practiceTag(true), /class="practice-tag">Practice, not scored</);
  assert.match(hudShell({ teamName: 'A', headline: 'h', topline: 't' }), /id="practice-tag"/);
});

test('switch_paths: case changes switch, restart resets', () => {
  assert.match(main, /startCase\(button\.dataset\.case!, 'switch'\)/);
  assert.match(main, /button\.id === 'confirm-restart'\) await startCase\(state\.caseId, 'reset'\)/);
  assert.match(main, /target === state\.caseId \? 'reset' : 'switch'/);
  assert.match(main, /action\(how, \{ caseId \}, fresh\)/);
});

test('copy: the switch note promises saved progress, the restart note keeps coins', () => {
  const text = JSON.parse(read('../client/text/main.json'));
  assert.match(text['main.preview.noteStarting'], /progress.*saved/i);
  assert.match(text['main.preview.noteRestarting'], /interviews/);
  assert.match(text['main.preview.noteRestarting'], /coin count keeps going/);
  assert.match(text['main.reset.body'], /coin count keeps going/);
  // Only the last sentence changed: the authored opening stays word for word.
  assert.ok(text['main.reset.body'].startsWith('Your chats with the {many} and your guess are cleared, and the case starts again from the briefing. '));
});
