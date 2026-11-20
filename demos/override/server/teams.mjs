// Team registry: one name, one team. Restored from teams.jsonl at start.
import { randomUUID } from 'node:crypto';
import { RequestError } from './session.mjs';
import { appendJsonl, readJsonl } from './dataset.mjs';

const NAME = /^[\p{L}\p{N}][\p{L}\p{N}\p{M} '’&.\-!?#]*$/u;
export const NAME_ERROR = 'Team names are 2 to 24 letters, numbers and spaces.';
export const FULL_ERROR = 'The team list is full. Ask the organisers.';
export const CONSENT_ERROR = 'Tick the box to agree before you play.';
// Bump when the check-in notice changes, so each team record says which wording it agreed to.
export const CONSENT_VERSION = 'research-public-v1';

export function teamName(raw) {
  if (typeof raw !== 'string') return null;
  const name = raw.normalize('NFC').trim().replace(/\s+/gu, ' ');
  const length = [...name].length;
  if (length < 2 || length > 24 || !NAME.test(name)) return null;
  return { name, key: name.toLowerCase() };
}

export function createTeams({ file = null, max = 1000 } = {}) {
  const byId = new Map();
  const byKey = new Map();

  function add(id, name) {
    const team = { id, name, sessionId: null, sessions: Object.create(null) };
    byId.set(id, team);
    byKey.set(name.toLowerCase(), team);
    return team;
  }

  if (file) {
    for (const r of readJsonl(file, { repair: true })) {
      if (r?.type === 'team_created' && typeof r.teamId === 'string') {
        const p = teamName(r.name);
        if (p && !byId.has(r.teamId) && !byKey.has(p.key)) add(r.teamId, p.name);
      }
      else if (r?.type === 'teams_reset') { byId.clear(); byKey.clear(); }
      else if (r?.type === 'team_session' && byId.has(r.teamId) && typeof r.sessionId === 'string') {
        // Old records carry no caseId: they restore only the current session.
        const t = byId.get(r.teamId);
        t.sessionId = r.sessionId;
        if (typeof r.caseId === 'string' && r.caseId) t.sessions[r.caseId] = r.sessionId;
      }
    }
  }

  const view = (t) => ({ id: t.id, name: t.name, sessionId: t.sessionId, sessions: { ...t.sessions } });

  // A name belongs to the browser that made it. Nobody joins an existing team by typing its name.
  // Playing is a research study: no team is made without the check-in consent.
  function join(raw, consent = false) {
    const parsed = teamName(raw);
    if (!parsed) throw new RequestError(400, NAME_ERROR);
    if (consent !== true) throw new RequestError(400, CONSENT_ERROR);
    const known = byKey.get(parsed.key);
    if (known) return { taken: known.name };
    if (byId.size >= max) throw new RequestError(503, FULL_ERROR);
    const id = randomUUID();
    if (file) appendJsonl(file, { type: 'team_created', teamId: id, name: parsed.name, consent: CONSENT_VERSION, timestamp: new Date().toISOString() }, 'teams');
    return { team: view(add(id, parsed.name)), created: true };
  }

  function find(id) {
    const t = typeof id === 'string' ? byId.get(id) : undefined;
    return t ? view(t) : null;
  }

  function exists(raw) {
    const parsed = teamName(raw);
    return parsed ? byKey.has(parsed.key) : false;
  }

  // The team's saved session of a case, or null.
  function sessionFor(id, caseId) {
    const t = typeof id === 'string' ? byId.get(id) : undefined;
    return (t && typeof caseId === 'string' && t.sessions[caseId]) || null;
  }

  // Make a session the team's current one, and remember it as the team's game of that case.
  // Nothing changed means nothing is written.
  function attach(id, sessionId, caseId) {
    const t = byId.get(id);
    if (!t) return;
    const saved = typeof caseId === 'string' && caseId ? caseId : null;
    if (t.sessionId === sessionId && (!saved || t.sessions[saved] === sessionId)) return;
    t.sessionId = sessionId;
    if (saved) t.sessions[saved] = sessionId;
    if (!file) return;
    try { appendJsonl(file, { type: 'team_session', teamId: id, sessionId, ...(saved ? { caseId: saved } : {}), timestamp: new Date().toISOString() }, 'teams'); } catch (error) {
      console.error('Could not record the team session.', error);
    }
  }

  // Forget every team (a new event). The file keeps a marker so a restart forgets them too.
  function reset() {
    const n = byId.size;
    if (file) appendJsonl(file, { type: 'teams_reset', timestamp: new Date().toISOString() }, 'teams');
    byId.clear();
    byKey.clear();
    return n;
  }

  return { join, find, exists, attach, sessionFor, reset };
}
