import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Investigation, replay } from '../server/session.mjs';
import { readJsonl } from '../server/dataset.mjs';
import { defineCase } from '../server/cases.mjs';
import { economyRules, createWallet, quote } from '../server/economy.mjs';
import { createLeaderboard } from '../server/leaderboard.mjs';
import { partCase, towerPartCase, agentWorlds } from './fixtures/minimal-case.mjs';
import { modelConfig } from '../server/interviews.mjs';

const kase = defineCase(partCase, { worlds: agentWorlds(3) });
const tower = defineCase(towerPartCase(), { worlds: agentWorlds(3) });
const ALL_HONEST = { momo: 'honest', pip: 'honest', nori: 'honest' };

function setup(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'override-carry-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const inv = new Investigation({ dataDir: dir, config: modelConfig({}), kase, shuffle: ids => [...ids], ...options });
  const act = (action, input = {}, extra) => inv.mutate(action, { sessionId: inv.session?.id, revision: inv.session?.revision, ...input }, extra);
  const log = id => readJsonl(join(dir, 'sessions', `${id}.jsonl`));
  return { inv, act, log };
}
const ask = async (act, n) => { for (let i = 0; i < n; i++) await act('interview', { character: 'pip', question: `Q${i}?` }); };

test('restart of an open case carries the coins; logged totals stay per session', async t => {
  const { inv, act, log } = setup(t);
  await act('start');
  await ask(act, 5);
  assert.equal(inv.view().session.economy.spent, 5);
  const oldId = inv.session.id;
  const v = await act('reset');
  assert.equal(v.session.economy.carried, 5);
  assert.equal(v.session.economy.spent, 5);
  assert.equal(v.session.practice, false);
  await ask(act, 1);
  assert.equal(inv.view().session.economy.spent, 6);
  assert.equal(inv.session.economy.spent, 1, 'stored wallet is per session');
  const events = log(inv.session.id);
  assert.equal(events[0].economy.carried, 5);
  assert.equal(events[0].practice, false);
  assert.equal(events.filter(e => e.spend).at(-1).spend.total, 1);
  assert.ok(log(oldId).some(e => e.type === 'session_reset'));
  const back = replay(events, [kase]);
  assert.equal(back.economy.carried, 5);
  assert.equal(back.practice, false);
});

test('carry accumulates over several restarts', async t => {
  const { act } = setup(t);
  await act('start'); await ask(act, 2);
  await act('reset'); await ask(act, 3);
  const v = await act('reset');
  assert.equal(v.session.economy.carried, 5);
  assert.equal(v.session.economy.spent, 5);
});

test('restart after a verdict is practice: nothing carried, shown 0', async t => {
  const { inv, act, log } = setup(t);
  await act('start'); await ask(act, 3);
  for (const id of ['momo', 'pip', 'nori']) if (!inv.session.interviews[id].length) await act('interview', { character: id, question: 'Hi?' });
  await act('verdict', { roles: ALL_HONEST, confidence: 50 });
  assert.equal(inv.session.status, 'closed');
  const v = await act('reset');
  assert.equal(v.session.practice, true);
  assert.equal(v.session.economy.carried, 0);
  assert.equal(v.session.economy.spent, 0);
  assert.equal(log(inv.session.id)[0].practice, true);
  assert.equal(replay(log(inv.session.id), [kase]).practice, true);
  await ask(act, 2);
  const w = await act('reset');
  assert.equal(w.session.practice, true);
  assert.equal(w.session.economy.carried, 2);
});

test('a reset to a different case starts clean', async t => {
  const { act } = setup(t);
  await act('start'); await ask(act, 4);
  const v = await act('reset', {}, { kase: tower });
  assert.equal(v.session.caseId, 'mini-tower-parts');
  assert.equal(v.session.economy.carried, 0);
  assert.equal(v.session.economy.spent, 0);
  assert.equal(v.session.practice, false);
});

test('old logs without carried or practice replay as 0 and false', async t => {
  const { inv, act, log } = setup(t);
  await act('start');
  const events = structuredClone(log(inv.session.id));
  delete events[0].practice; delete events[0].economy.carried;
  const s = replay(events, [kase]);
  assert.equal(s.economy.carried ?? 0, 0);
  assert.equal(s.practice, false);
});

test('quote checks budget - spent - carried', () => {
  const w = createWallet({ ...economyRules({ budget: 10 }), carried: 8 });
  assert.equal(w.spent, 0);
  assert.equal(quote(w, ['ask'], 0).ok, true);
  assert.equal(quote(w, ['inspect'], 0).ok, false);
  assert.match(quote(w, ['inspect'], 0).reason, /2 left/);
});

test('the leaderboard ignores a practice session and its events', () => {
  const lb = createLeaderboard([{ id: 'banana-mystery', title: 'B', order: 1, characters: [{}, {}, {}] }], { startedAt: 0, now: () => 5000 });
  const team = { id: 'A', name: 'Squad' };
  const iso = s => new Date(s * 1000).toISOString();
  lb.observe({ type: 'session_started', sessionId: 'p', caseId: 'banana-mystery', timestamp: iso(1), team, practice: true });
  lb.observe({ type: 'x', sessionId: 'p', timestamp: iso(2), spend: { total: 9 } });
  lb.observe({ type: 'verdict_submitted', sessionId: 'p', timestamp: iso(3), verdict: { score: 3 }, coins: { spent: 9 } });
  assert.equal(lb.standings({ includeHidden: false, you: null }).teams.length, 0);
});
