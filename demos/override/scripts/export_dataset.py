"""Export one event's game logs as a Hugging Face dataset: one Parquet table (one row per game) + raw JSONL + card.

Usage (from demos/override):
  uv run --with pyarrow --with huggingface_hub scripts/export_dataset.py \
      --event-dir <snapshot>/imadacup-20-11 --out <dir> [--push <org-or-user>/arbiter-imadacup-traces]

Reads only the snapshot. Each row of data/games.parquet is a whole game: team, case, verdict, score,
coins per tool, the characters (name, hidden part, true and guessed role) and the transcript in order
(questions with answers and the model's reasoning, talk lines, reasoning inspections).
Full model calls (prompts, retries) stay in raw/<event>/traces/.
"""
import argparse
import glob
import hashlib
import json
import os
import re
import shutil

import pyarrow as pa
import pyarrow.parquet as pq

VOIDS_FILE = os.path.join(os.path.dirname(__file__), '..', 'server', 'leaderboard-voids.json')

CHARACTER = pa.struct([
    ('id', pa.string()), ('name', pa.string()), ('label', pa.string()), ('part', pa.string()),
    ('true_role', pa.string()), ('guessed_role', pa.string()), ('correct', pa.bool_()),
])
TURN = pa.struct([
    ('t_ms', pa.int64()), ('timestamp', pa.string()), ('type', pa.string()), ('character', pa.string()),
    ('question', pa.string()), ('answer', pa.string()), ('reasoning', pa.string()), ('reasoning_inspected', pa.bool_()),
    ('round', pa.int64()), ('text', pa.string()), ('coins', pa.int64()),
    ('model', pa.string()), ('prompt_tokens', pa.int64()), ('completion_tokens', pa.int64()),
    ('reasoning_tokens', pa.int64()), ('latency_ms', pa.int64()), ('finish_reason', pa.string()),
])
SCHEMA = pa.schema([
    ('game_id', pa.string()), ('event', pa.string()), ('team_id', pa.string()), ('team_name', pa.string()),
    ('case_id', pa.string()), ('case_version', pa.string()), ('model', pa.string()), ('app_commit', pa.string()),
    ('started_at', pa.string()), ('ended_at', pa.string()), ('duration_ms', pa.int64()),
    ('practice', pa.bool_()), ('leaderboard_counted', pa.bool_()), ('leaderboard_voided', pa.bool_()),
    ('outcome', pa.string()), ('score', pa.int64()), ('total', pa.int64()), ('confidence', pa.int64()),
    ('questions', pa.int64()), ('talk_rounds', pa.int64()), ('talk_lines', pa.int64()), ('reasoning_inspections', pa.int64()),
    ('coins', pa.struct([('spent', pa.int64()), ('ask', pa.int64()), ('inspect', pa.int64()), ('talk', pa.int64())])),
    ('characters', pa.list_(CHARACTER)), ('transcript', pa.list_(TURN)),
])
TURN_KEYS = [f.name for f in TURN]


def read_jsonl(path):
    with open(path, encoding='utf-8') as f:
        return [json.loads(line) for line in f if line.strip()]


def name_of(messages):
    """'You play Sabine (Professor).' -> ('Sabine', 'Professor'): the name the players saw."""
    system = next((m['content'] for m in messages if m.get('role') == 'system'), '')
    m = re.match(r'You play (.+?) \((.+?)\)', system)
    return (m.group(1), m.group(2)) if m else (None, None)


def turn(**fields):
    return {k: fields.get(k) for k in TURN_KEYS}


def export(event_dir, out):
    event = os.path.basename(os.path.normpath(event_dir))
    voids = json.load(open(VOIDS_FILE, encoding='utf-8')) if os.path.exists(VOIDS_FILE) else []
    voided = {v['sessionId'] for v in voids}
    counted_instead = {v['countInstead'] for v in voids if v.get('countInstead')}
    teams = {r['teamId'] for r in read_jsonl(os.path.join(event_dir, 'teams.jsonl')) if r.get('type') == 'team_created'}

    traces = {}
    for f in glob.glob(os.path.join(event_dir, 'traces', '*.jsonl')):
        for t in read_jsonl(f):
            traces[t['traceId']] = t
    trace_by_question = {}  # question event -> (name, label) of the character the model played
    for t in traces.values():
        if t.get('questionEventId'):
            trace_by_question[t['questionEventId']] = name_of(t['request'].get('messages') or [])

    games, first_verdict = [], {}  # first_verdict: (team, case) -> (ms, game) the leaderboard counts
    for f in sorted(glob.glob(os.path.join(event_dir, 'sessions', '*.jsonl'))):
        ev = sorted(read_jsonl(f), key=lambda e: e['sequence'])
        st = next(e for e in ev if e['type'] == 'session_started')
        sid, case = st['sessionId'], st['caseId']
        team = st.get('team') or {}
        cast = st.get('cast') or {}
        verdict_ev = next((e for e in ev if e['type'] == 'verdict_submitted'), None)
        v = (verdict_ev or {}).get('verdict') or {}
        truth, guessed, results = v.get('truth') or {}, v.get('roles') or {}, v.get('results') or {}
        questions = {e['eventId']: e for e in ev if e['type'] == 'interview_question'}
        inspected = {e.get('sourceEventId') for e in ev if e['type'] == 'reasoning_inspected'}
        provider = {e.get('questionEventId'): e for e in ev if e['type'] == 'interview_provider_response'}
        answer_char = {e['eventId']: e.get('character') for e in ev if e['type'] == 'interview_answer'}
        names = {}
        coins = {'ask': 0, 'inspect': 0, 'talk': 0}
        transcript = []
        for e in ev:
            spend = (e.get('spend') or {}).get('cost') or 0
            if e['type'] == 'interview_answer':
                p = e.get('provenance') or {}
                # The game log holds reasoning only once a team inspects it; the answer's own trace always has it.
                trace = next((traces[t] for t in reversed(p.get('traceIds') or []) if t in traces), None)
                names.setdefault(e.get('character'), trace_by_question.get(e.get('questionEventId'), (None, None)))
                coins['ask'] += spend
                transcript.append(turn(
                    t_ms=e.get('elapsedMs'), timestamp=e['timestamp'], type='question', character=e.get('character'),
                    question=e.get('question') or (questions.get(e.get('questionEventId')) or {}).get('question'),
                    answer=e.get('answer'), reasoning=e.get('reasoning') or ((trace or {}).get('response') or {}).get('reasoning'),
                    reasoning_inspected=e['eventId'] in inspected, coins=spend, model=p.get('providerModel'),
                    prompt_tokens=p.get('promptTokens'), completion_tokens=p.get('completionTokens'),
                    reasoning_tokens=p.get('reasoningTokens'), latency_ms=p.get('durationMs'),
                    finish_reason=(provider.get(e.get('questionEventId')) or {}).get('finishReason')))
            elif e['type'] == 'chatter_line':
                coins['talk'] += spend
                transcript.append(turn(t_ms=e.get('elapsedMs'), timestamp=e['timestamp'], type='talk', character=e.get('character'),
                                       round=e.get('round'), text=e.get('text'), coins=spend))
            elif e['type'] == 'reasoning_inspected':
                coins['inspect'] += spend
                transcript.append(turn(t_ms=e.get('elapsedMs'), timestamp=e['timestamp'], type='inspect',
                                       character=e.get('character') or answer_char.get(e.get('sourceEventId')), coins=spend))

        practice = bool(st.get('practice'))
        outcome = None if not verdict_ev else ('timed_out' if v.get('outcome') == 'escaped' else 'verdict')
        if verdict_ev and team.get('id') and ((not practice) or sid in counted_instead) and sid not in voided:
            key, ms = (team['id'], case), verdict_ev['timestamp']
            if key not in first_verdict or ms < first_verdict[key][0]:
                first_verdict[key] = (ms, sid)
        ids = list(cast) or list(truth)
        games.append({
            'game_id': sid, 'event': st.get('env'), 'team_id': team.get('id'), 'team_name': team.get('name'),
            'case_id': case, 'case_version': st.get('caseVersion'), 'model': st.get('model'), 'app_commit': st.get('appCommit'),
            'started_at': st['timestamp'], 'ended_at': (verdict_ev or {}).get('timestamp'),
            'duration_ms': (verdict_ev or {}).get('elapsedMs'), 'practice': practice,
            'leaderboard_counted': False, 'leaderboard_voided': sid in voided,
            'outcome': outcome, 'score': v.get('score'), 'total': v.get('total'), 'confidence': v.get('confidence'),
            'questions': sum(t['type'] == 'question' for t in transcript),
            'talk_rounds': len({t['round'] for t in transcript if t['type'] == 'talk'}),
            'talk_lines': sum(t['type'] == 'talk' for t in transcript),
            'reasoning_inspections': sum(t['type'] == 'inspect' for t in transcript),
            'coins': {'spent': ((verdict_ev or {}).get('coins') or {}).get('spent'), **coins},
            'characters': [{'id': c, 'name': names.get(c, (None, None))[0], 'label': names.get(c, (None, None))[1],
                            'part': cast.get(c), 'true_role': truth.get(c), 'guessed_role': guessed.get(c),
                            'correct': results.get(c)} for c in ids],
            'transcript': transcript,
        })
    counted = {s for _, s in first_verdict.values()}
    for g in games:
        g['leaderboard_counted'] = g['game_id'] in counted
    games.sort(key=lambda g: g['started_at'])

    if os.path.exists(out):
        shutil.rmtree(out)
    os.makedirs(os.path.join(out, 'data'))
    pq.write_table(pa.Table.from_pylist(games, schema=SCHEMA), os.path.join(out, 'data', 'games.parquet'))

    raw = os.path.join(out, 'raw', event)
    shutil.copytree(event_dir, raw, ignore=shutil.ignore_patterns('content'))
    sums = [f'{hashlib.sha256(open(f, "rb").read()).hexdigest()}  {os.path.relpath(f, raw)}'
            for f in sorted(glob.glob(os.path.join(raw, '**', '*.jsonl'), recursive=True))]
    open(os.path.join(raw, 'SHA256SUMS'), 'w').write('\n'.join(sums) + '\n')

    stats = summarize(games, teams, traces)
    open(os.path.join(out, 'README.md'), 'w', encoding='utf-8').write(card(event, stats, voids))
    return stats


def summarize(games, teams, traces):
    turns = [t for g in games for t in g['transcript']]
    return {
        'teams': len(teams), 'games': len(games), 'counted': sum(g['leaderboard_counted'] for g in games),
        'questions': sum(t['type'] == 'question' for t in turns), 'talk_lines': sum(t['type'] == 'talk' for t in turns),
        'talk_rounds': sum(g['talk_rounds'] for g in games), 'reasoning_inspections': sum(t['type'] == 'inspect' for t in turns),
        'llm_calls': len(traces), 'llm_errors': sum(1 for t in traces.values() if t.get('error')),
        'models': sorted({g['model'] for g in games if g['model']}),
        'cases': sorted({g['case_id'] for g in games}),
    }


def card(event, s, voids):
    split = event.replace('-', '_')
    lines = [
        '---',
        'pretty_name: Arbiter · IMADA Cup traces',
        'language: [en]',
        'tags: [llm, deception, interrogation, game, traces]',
        'configs:',
        '- config_name: default',
        '  data_files:',
        f'  - split: {split}',
        '    path: data/games.parquet',
        '---', '',
        '# Arbiter · IMADA Cup traces', '',
        f'Game logs from **{event}**: teams questioned AI characters in *The Arbiter*, a detective game where some characters hide a secret role, and then named each character\'s role.', '',
        f"**{s['teams']} teams · {s['games']} games ({s['counted']} counted on the leaderboard) · {s['questions']} questions · "
        f"{s['talk_rounds']} talk rounds ({s['talk_lines']} lines) · {s['reasoning_inspections']} reasoning inspections** · model: {', '.join(s['models'])}", '',
        '## Load it', '',
        '```python',
        'import pandas as pd',
        'from datasets import load_dataset',
        f'games = load_dataset("aisilab/arbiter-imadacup-traces", split="{split}")',
        '',
        '# one row per transcript turn, with the speaker\'s true role',
        'turns = pd.DataFrame([',
        '    {"game_id": g["game_id"], "case_id": g["case_id"], **t,',
        '     "true_role": {c["id"]: c["true_role"] for c in g["characters"]}.get(t["character"])}',
        '    for g in games for t in g["transcript"]])',
        'answers = turns[turns.type == "question"]',
        '```', '',
        '## One row per game', '',
        '| column | what it holds |', '|---|---|',
        '| `game_id`, `event`, `team_id`, `team_name` | who played |',
        '| `case_id`, `case_version`, `model`, `app_commit` | what they played, and on which build |',
        '| `started_at`, `ended_at`, `duration_ms` | timing (`duration_ms` is time to verdict) |',
        '| `practice`, `leaderboard_counted`, `leaderboard_voided` | whether the game scored: only each team\'s first non-practice verdict per case counts |',
        '| `outcome` | `verdict`, `timed_out` (the case clock ran out), or empty (game abandoned) |',
        '| `score`, `total`, `confidence` | roles named right, out of how many; the team\'s own confidence (0–100) |',
        '| `questions`, `talk_rounds`, `talk_lines`, `reasoning_inspections` | tool use |',
        '| `coins` | `{spent, ask, inspect, talk}`: questions cost 1, an inspection 3, a talk round 2 |',
        '| `characters` | list of `{id, name, label, part, true_role, guessed_role, correct}`. `part` is the hidden script the character was dealt; `name`/`label` are what players saw (empty if never questioned) |',
        '| `transcript` | the game in order: `type` is `question` (question, answer, the model\'s reasoning, whether it was inspected, tokens, latency), `talk` (round, text) or `inspect`; `t_ms` is time since the game started |', '',
        f'`raw/{event}/` holds the original logs with SHA256SUMS: `sessions/` (every game event), `traces/` (all {s["llm_calls"]} model calls with full prompts), `teams.jsonl`.', '',
        '## Consent', '',
        'Every team ticked the check-in box (`research-public-v1`): "I agree that our team name, questions and answers are saved, used in research and made public." No IP addresses, emails or real names are collected; teams chose their own names.', '',
        '## Known issues', '',
        '- `reasoning` is filled for every answer, also ones the team never inspected; use `reasoning_inspected` for what players saw.',
        '- Clocking Out\'s 10-minute clock kept running while a team played another case, so a game could time out with no questions (`outcome = timed_out`).',
        '- Clocking Out reasoning is written in ROT13 on purpose (a game mechanic).',
        '- Games started after 17:45 UTC on 2026-11-20 record `app_commit` 6fcf60d but ran 830ac4a (leaderboard fix only).',
    ]
    for v in voids:
        lines.append(f"- Leaderboard correction for {v.get('team')}: game {v['sessionId']} voided, {v.get('countInstead')} counted instead. {v.get('reason', '')}")
    lines += ['', 'Internal for now: no license chosen yet.', '']
    return '\n'.join(lines)


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--event-dir', required=True)
    ap.add_argument('--out', required=True, help='output folder (replaced)')
    ap.add_argument('--push', help='Hugging Face repo id, e.g. aisilab/arbiter-imadacup-traces (created private)')
    a = ap.parse_args()
    stats = export(a.event_dir, a.out)
    print(json.dumps(stats))
    if a.push:
        from huggingface_hub import HfApi
        api = HfApi()
        api.create_repo(a.push, repo_type='dataset', private=True, exist_ok=True)
        api.upload_folder(repo_id=a.push, repo_type='dataset', folder_path=a.out, delete_patterns=['*'],
                          commit_message=f'Add {os.path.basename(os.path.normpath(a.event_dir))}: one row per game')
        print(f'pushed (private): https://huggingface.co/datasets/{a.push}')
