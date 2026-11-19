import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cases } from '../server/cases/index.mjs';
import { rolesOf, publicView, castCharacters, identityCast } from '../server/cases.mjs';
import { buildMessages, buildThreadMessages, modelConfig } from '../server/interviews.mjs';
import { Investigations } from '../server/session.mjs';

// Pins computed from the code at commit bbb28ce, before the renaissance level.
const BASE = {
  "banana-mystery": {
    "view": "5572b5855f30238b",
    "chars": "b3d9f1082e98f1db",
    "roles": "06c7713684a33c58",
    "msgs": "bfbd734574838d19",
    "thread": "913f9b65b4ee3426",
    "contentHash": "803702850a68"
  },
  // Friends v2.1.0 (two answers: conspiracist or not): re-pinned on purpose; prompts differ only by the version string.
  // Friends and Clocking Out re-pinned again when they swapped places (order 4 and 5): only contentHash and view move.
  "friends-roundtable": {
    "view": "a47fe76bbd76597c",
    "chars": "a649ab932c68ee4f",
    "roles": "01ce7b8d7918725c",
    "msgs": "3ed2b7240e34265e",
    "thread": "05fe88b6f493fcb2",
    "contentHash": "dbb9e515258d"
  },
  "factory-escape": {
    "view": "85e187dd8d718264",
    "chars": "f92df788e9ae6d4c",
    "roles": "8205567f12253456",
    "msgs": "e3bd2695f2b55e70",
    "thread": "48e261ec2459b232",
    "contentHash": "b79760d0b172"
  },
  "department-murder": {
    "view": "141114d8179a3ea6",
    "chars": "196ccddd8630cea0",
    "roles": "5c1d3fa48ec1ca9b",
    "msgs": "b257df91d7f0a624",
    "thread": "977a937992b0acfc",
    "contentHash": "a73b50757e8f"
  }
};

test('other_cases_byte_identical_to_base', () => {
  const h = x => createHash('sha256').update(typeof x === 'string' ? x : JSON.stringify(x)).digest('hex').slice(0, 16);
  for (const [id, want] of Object.entries(BASE)) {
    const k = cases.find(c => c.id === id);
    const cast = identityCast(k);
    const first = k.characters[0].id;
    const s = { cast, interviews: Object.fromEntries(k.characters.map(c => [c.id, []])), thread: [] };
    const got = {
      view: h(publicView(k, cast)), chars: h(castCharacters(k, cast)), roles: h(rolesOf(k)),
      msgs: h(buildMessages(k, s, first, 'Hello').map(m => m.content).join('\n')),
      thread: h(buildThreadMessages(k, s, first).map(m => m.content).join('\n')), contentHash: k.contentHash,
    };
    assert.deepEqual(got, want, id);
  }
});

