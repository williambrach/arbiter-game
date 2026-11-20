import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/index.mjs';
import { createTeams } from '../server/teams.mjs';
import { Investigations } from '../server/session.mjs';
import { modelConfig } from '../server/interviews.mjs';

const json = { 'Content-Type': 'application/json' };
const A = 'banana-mystery';
const B = 'friends-roundtable';

async function boot(t, { dir = null, teamsFile = null, teamId = null } = {}) {
  if (!dir) { dir = mkdtempSync(join(tmpdir(), 'override-switch-')); t.after(() => rmSync(dir, { recursive: true, force: true })); }
  const teams = createTeams({ file: teamsFile });
  const investigations = new Investigations({ dataDir: dir, config: modelConfig({}), answer: () => 'I never heard the bell.' });
  const app = createApp({ investigations, teams });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(async () => { app.closeAllConnections(); await new Promise(resolve => app.close(resolve)); });
  const base = `http://127.0.0.1:${app.address().port}`;
  const jar = {};
  const call = async (path, body) => {
    const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { ...(body ? json : {}), Cookie: cookie }, body: body ? JSON.stringify(body) : undefined });
    const raw = res.headers.get('set-cookie');
    if (raw) { const [kv] = raw.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1); }
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const team = teamId ? teams.find(teamId) : teams.join('Owls', true).team;
  jar.override_team = team.id;
  return { call, teams, team, dir, investigations, jar };
}
const log = (dir, id) => readFileSync(join(dir, 'sessions', `${id}.jsonl`), 'utf8').trim().split('\n').map(JSON.parse);

test('switch resumes the saved game and starts a new one without touching the old log', async t => {
  const g = await boot(t);
  const s1 = (await g.call('/api/start', { caseId: A })).body;
  assert.equal(s1.session.caseId, A);
  const talked = (await g.call('/api/interview', { sessionId: s1.session.id, revision: s1.session.revision, character: 'momo', question: 'What happened?' })).body;
  const before = readFileSync(join(g.dir, 'sessions', `${s1.session.id}.jsonl`), 'utf8');

  const s2 = await g.call('/api/switch', { caseId: B });
  assert.equal(s2.status, 200);
  assert.equal(s2.body.session.caseId, B);
  assert.notEqual(s2.body.session.id, s1.session.id);
  // no_reset_on_switch: the left log is unchanged and still replays.
  assert.equal(readFileSync(join(g.dir, 'sessions', `${s1.session.id}.jsonl`), 'utf8'), before);
  assert.ok(!log(g.dir, s1.session.id).some(e => e.type === 'session_reset'));
  assert.equal((await g.call('/api/state')).body.session.id, s2.body.session.id);

  // resume: the first game comes back with its interviews.
  const back = await g.call('/api/switch', { caseId: A });
  assert.equal(back.body.session.id, s1.session.id);
  assert.equal(back.body.session.revision, talked.session.revision);
  assert.equal((await g.call('/api/state')).body.session.id, s1.session.id);
  assert.equal(g.teams.sessionFor(g.team.id, B), s2.body.session.id);
  assert.equal(g.teams.find(g.team.id).sessionId, s1.session.id);
});

test('resume takes no new-game slot', async t => {
  const g = await boot(t);
  await g.call('/api/start', { caseId: A });
  await g.call('/api/switch', { caseId: B });
  g.investigations.newGames.take = () => false;
  assert.equal((await g.call('/api/switch', { caseId: A })).status, 200);
  assert.equal((await g.call('/api/switch', { caseId: B })).status, 200);
});

test('legacy team record: the current session of that case is resumed', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'override-switch-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const g = await boot(t, { dir });
  const s1 = (await g.call('/api/start', { caseId: A })).body;
  // An old team file: the record has no caseId.
  const file = join(dir, 'legacy.jsonl');
  appendFileSync(file, JSON.stringify({ type: 'team_created', teamId: g.team.id, name: 'Owls', timestamp: 'x' }) + '\n' + JSON.stringify({ type: 'team_session', teamId: g.team.id, sessionId: s1.session.id, timestamp: 'x' }) + '\n');
  const g2 = await boot(t, { dir, teamsFile: file, teamId: g.team.id });
  assert.deepEqual(g2.teams.find(g.team.id).sessions, {});
  const back = await g2.call('/api/switch', { caseId: A });
  assert.equal(back.body.session.id, s1.session.id);
  assert.equal(g2.teams.sessionFor(g.team.id, A), s1.session.id);
});

test('unknown case is a 400 and changes nothing', async t => {
  const g = await boot(t);
  const s1 = (await g.call('/api/start', { caseId: A })).body;
  const bad = await g.call('/api/switch', { caseId: 'nope' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, 'Unknown case.');
  assert.equal((await g.call('/api/switch', {})).status, 400);
  assert.equal((await g.call('/api/state')).body.session.id, s1.session.id);
});

test('without a team, switch is a reset into that case', async t => {
  const g = await boot(t);
  delete g.jar.override_team;
  const s1 = (await g.call('/api/start', { caseId: A })).body;
  const next = await g.call('/api/switch', { caseId: B, sessionId: s1.session.id, revision: s1.session.revision });
  assert.equal(next.status, 200);
  assert.equal(next.body.session.caseId, B);
  assert.notEqual(next.body.session.id, s1.session.id);
  assert.equal((await g.call('/api/state')).body.session.id, next.body.session.id);
});

test('team mutations attach the session with its case', async t => {
  const g = await boot(t);
  const s1 = (await g.call('/api/start', { caseId: A })).body;
  assert.equal(g.teams.sessionFor(g.team.id, A), s1.session.id);
  const reset = (await g.call('/api/reset', { sessionId: s1.session.id, revision: s1.session.revision, caseId: A })).body;
  assert.equal(g.teams.sessionFor(g.team.id, A), reset.session.id);
});

test('seam: switch back to a solved case, then Restart there is practice and never scores', async t => {
  const g = await boot(t);
  let v = (await g.call('/api/start', { caseId: A })).body;
  const ids = g.investigations.find(v.session.id).kase.characters.map(c => c.id);
  for (const character of ids) {
    v = (await g.call('/api/interview', { sessionId: v.session.id, revision: v.session.revision, character, question: 'What happened?' })).body;
  }
  const solved = (await g.call('/api/verdict', { sessionId: v.session.id, revision: v.session.revision, roles: Object.fromEntries(ids.map(id => [id, 'honest'])), confidence: 70 })).body;
  assert.equal(solved.session.status, 'closed');
  await g.call('/api/switch', { caseId: B });
  const back = (await g.call('/api/switch', { caseId: A })).body;
  assert.equal(back.session.id, solved.session.id);
  assert.equal(back.session.status, 'closed');
  const again = await g.call('/api/reset', { sessionId: back.session.id, revision: back.session.revision, caseId: A });
  assert.equal(again.status, 200);
  assert.equal(again.body.session.practice, true);
  assert.equal(again.body.session.economy.spent, 0);
  assert.equal(log(g.dir, again.body.session.id)[0].practice, true);
  assert.equal(g.teams.sessionFor(g.team.id, A), again.body.session.id);
});
