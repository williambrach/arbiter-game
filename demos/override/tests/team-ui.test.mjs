import test from 'node:test';
import assert from 'node:assert/strict';
import { teamNameError, teamGate, leaderboardPanel } from '../client/team.ts';

const MSG = 'Team names are 2 to 24 letters, numbers and spaces.';
const gate = (o = {}) => teamGate({ name: '', error: '', taken: null, busy: false, switching: false, ...o });
const row = (o = {}) => ({ rank: 1, name: 'Owls', points: 1, played: 1, timeMs: 125000, coins: 8, you: true, ...o });

test('team_name_error', () => {
  assert.equal(teamNameError('Owls'), null);
  assert.equal(teamNameError('  Žluťoučký  kůň '), null);
  assert.equal(teamNameError("R&D's #1!"), null);
  for (const bad of ['x', '', '   ', '#hash', '<b>', 'a'.repeat(25)]) assert.equal(teamNameError(bad), MSG);
});

test('gate', () => {
  const html = gate();
  for (const s of ['id="team-form"', 'id="team-name"', 'maxlength="24"', 'id="team-submit"', 'id="team-error"', 'TEAM CHECK-IN']) assert.ok(html.includes(s), s);
  assert.ok(!html.includes('team-join') && !html.includes('team-cancel'));
  const t = gate({ taken: 'Owls', switching: true });
  assert.ok(!t.includes('team-join') && t.includes('id="team-other"') && t.includes('id="team-cancel"'));
});

test('names_escaped', () => {
  const evil = '<img onerror=x>';
  const html = leaderboardPanel({ teams: [row({ name: evil })] });
  assert.ok(html.includes('&lt;img') && !html.includes('<img'));
  const g = gate({ name: evil, taken: evil, error: evil });
  assert.ok(g.includes('&lt;img') && !g.includes('<img'));
});

test('leaderboard', () => {
  const html = leaderboardPanel({ teams: [row()] });
  assert.ok(html.includes('class="board-row you"'));
  for (const s of ['>1<', 'Owls', '1 pt<', '8 coins', 'Ties by coins', 'Each case scores once per team: your first guess counts.']) assert.ok(html.includes(s), s);
  // Time is for admins only: players never see it.
  assert.ok(!html.includes('2:05') && !html.includes('>Time<') && !html.includes('Ties by time'));
  const b = leaderboardPanel({ teams: [row({ rank: null, points: 2, coins: 1, you: false })] });
  assert.ok(b.includes('Playing') && b.includes('2 pts') && b.includes('1 coin<') && b.includes('Ties by coins') && !b.includes('board-row you'));
  assert.ok(leaderboardPanel({ teams: [] }).includes('<p class="board-empty">No team has finished a case yet.</p>'));
});

test('leaderboard_cells', () => {
  const cases = [{ id: 'a', title: 'A', order: 1, total: 4 }];
  const html = leaderboardPanel({ cases, teams: [row({ cells: [{ caseId: 'a', state: 'partial', points: 3 }] })] });
  assert.ok(html.includes('class="board-row you"') && html.includes('class="cell partial"') && html.includes('<th>Cases</th>'));
  assert.ok(!leaderboardPanel({ teams: [row()] }).includes('class="cell'));
});

test('consent_gate', () => {
  const off = gate();
  assert.ok(off.includes('id="team-consent"') && !/id="team-consent"[^>]*checked/.test(off), 'box starts unticked');
  assert.match(off, /id="team-submit" class="primary-button" disabled/);
  assert.ok(off.includes('Tick the box to start playing.') && off.includes('they will be public') && off.includes('id="privacy-open"'));
  const on = gate({ agreed: true });
  assert.match(on, /id="team-consent" type="checkbox" checked/);
  assert.doesNotMatch(on, /id="team-submit"[^>]*disabled/);
  assert.match(gate({ agreed: true, busy: true }), /id="team-submit"[^>]*disabled/);
  const p = gate({ privacy: true, name: 'Owls' });
  assert.ok(p.includes('id="privacy-back"') && !p.includes('id="team-form"'));
  for (const s of ['Needed to play', 'Made public', 'No deletion', 'open dataset']) assert.ok(p.includes(s), s);
  assert.ok(!p.includes('How long') && !p.includes('[CONTACT'));
});
