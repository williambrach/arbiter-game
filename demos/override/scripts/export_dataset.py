"""Export one event's game logs as a Hugging Face dataset (Parquet tables + raw JSONL + card).

Usage (from demos/override):
  uv run --with pyarrow --with huggingface_hub scripts/export_dataset.py \
      --event-dir <snapshot>/imadacup-20-11 --out <dir> [--push <org-or-user>/arbiter-imadacup-traces]

Reads only the snapshot. Tables, one row per:
  games        game (session): team, case, outcome, guessed vs true roles, score, coins, leaderboard status
  interviews   question: who was asked, their hidden part and role, question, answer, reasoning, tokens, latency
  talk_lines   "Let them talk" line
  llm_calls    model call (trace): full prompt, reply, reasoning, settings, timings
  teams        team: id, name, consent version
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


def read_jsonl(path):
    rows = []
    with open(path, encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def name_of(messages):
    """'You play Sabine (Professor).' -> ('Sabine', 'Professor'): the name the players saw."""
    system = next((m['content'] for m in messages if m.get('role') == 'system'), '')
    m = re.match(r'You play (.+?) \((.+?)\)', system)
    return (m.group(1), m.group(2)) if m else (None, None)


def jdump(value):
    return None if value is None else json.dumps(value, ensure_ascii=False)


def export(event_dir, out):
    event = os.path.basename(os.path.normpath(event_dir))
    voids = json.load(open(VOIDS_FILE, encoding='utf-8')) if os.path.exists(VOIDS_FILE) else []
    voided = {v['sessionId'] for v in voids}
    counted_instead = {v['countInstead'] for v in voids if v.get('countInstead')}

    teams = {}
    for r in read_jsonl(os.path.join(event_dir, 'teams.jsonl')):
        if r.get('type') == 'team_created':
            teams[r['teamId']] = {'team_id': r['teamId'], 'team_name': r['name'], 'consent': r.get('consent'), 'created_at': r['timestamp']}

    traces = {}
    for f in glob.glob(os.path.join(event_dir, 'traces', '*.jsonl')):
        for t in read_jsonl(f):
            traces[t['traceId']] = t

    games, interviews, talk, calls = [], [], [], []
    names = {}  # (session, character) -> (name, label)
    for t in traces.values():
        msgs = t['request'].get('messages') or []
        call_char = None
        name, label = name_of(msgs)
        calls.append({
            'trace_id': t['traceId'], 'game_id': t.get('sessionId'), 'question_event_id': t.get('questionEventId'),
            'kind': 'interview' if t.get('questionEventId') else 'talk', 'attempt': t.get('attempt'),
            'timestamp': t['timestamp'], 'endpoint': t.get('endpoint'), 'model': t['request'].get('model'),
            'character_name': name, 'character_label': label,
            'params': jdump(t['request'].get('params')), 'messages': jdump(msgs),
            'system_prompt': next((m['content'] for m in msgs if m.get('role') == 'system'), None),
            'response_content': (t.get('response') or {}).get('content'),
            'response_reasoning': (t.get('response') or {}).get('reasoning'),
            'finish_reason': (t.get('response') or {}).get('finishReason'),
            'usage': jdump((t.get('response') or {}).get('usage')),
            'provider_status': t.get('providerStatus'), 'error': t.get('error'),
            'queue_ms': t.get('queueMs'), 'duration_ms': t.get('durationMs'),
        })
        if t.get('sessionId') and name:
            names.setdefault(t['sessionId'], {})
            names[t['sessionId']].setdefault(name, label)

    first_verdict = {}  # (team, case) -> (ms, session): which verdict the leaderboard counts
    for f in sorted(glob.glob(os.path.join(event_dir, 'sessions', '*.jsonl'))):
        ev = read_jsonl(f)
        st = next(e for e in ev if e['type'] == 'session_started')
        sid, case = st['sessionId'], st['caseId']
        team = st.get('team') or {}
        cast = st.get('cast') or {}
        verdict_ev = next((e for e in ev if e['type'] == 'verdict_submitted'), None)
        v = (verdict_ev or {}).get('verdict') or {}
        truth = v.get('truth') or {}
        q_by_id = {e['eventId']: e for e in ev if e['type'] == 'interview_question'}
        inspected = {e.get('sourceEventId') for e in ev if e['type'] == 'reasoning_inspected'}
        provider = {e.get('questionEventId'): e for e in ev if e['type'] == 'interview_provider_response'}
        for a in (e for e in ev if e['type'] == 'interview_answer'):
            q = q_by_id.get(a.get('questionEventId'), {})
            p = a.get('provenance') or {}
            pr = provider.get(a.get('questionEventId'), {})
            # The game log holds reasoning only once a team inspects it; the answer's own trace always has it.
            answered = next((traces[t] for t in reversed(p.get('traceIds') or []) if t in traces), None)
            reasoning = a.get('reasoning') or ((answered or {}).get('response') or {}).get('reasoning')
            interviews.append({
                'game_id': sid, 'team_id': team.get('id'), 'case_id': case, 'character_id': a.get('character'),
                'part': cast.get(a.get('character')), 'role': truth.get(a.get('character')),
                'question_event_id': a.get('questionEventId'), 'answer_event_id': a['eventId'],
                'asked_at': q.get('timestamp'), 'answered_at': a['timestamp'], 'elapsed_ms': a.get('elapsedMs'),
                'question': a.get('question'), 'answer': a.get('answer'), 'reasoning': reasoning,
                'reasoning_inspected': a['eventId'] in inspected,
                'endpoint': p.get('endpoint'), 'model': p.get('providerModel'), 'attempts': p.get('attempts'),
                'prompt_tokens': p.get('promptTokens'), 'completion_tokens': p.get('completionTokens'),
                'reasoning_tokens': p.get('reasoningTokens'), 'duration_ms': p.get('durationMs'),
                'finish_reason': pr.get('finishReason'), 'trace_ids': p.get('traceIds') or [],
            })
        for c in (e for e in ev if e['type'] == 'chatter_line'):
            talk.append({
                'game_id': sid, 'team_id': team.get('id'), 'case_id': case, 'round': c.get('round'),
                'character_id': c.get('character'), 'part': cast.get(c.get('character')), 'role': truth.get(c.get('character')),
                'timestamp': c['timestamp'], 'elapsed_ms': c.get('elapsedMs'), 'text': c.get('text'),
            })
        game_names = names.get(sid, {})
        practice = bool(st.get('practice'))
        outcome = None if not verdict_ev else ('timed_out' if v.get('outcome') == 'escaped' else 'verdict')
        if verdict_ev and team.get('id') and ((not practice) or sid in counted_instead) and sid not in voided:
            key = (team['id'], case)
            ms = verdict_ev['timestamp']
            if key not in first_verdict or ms < first_verdict[key][0]:
                first_verdict[key] = (ms, sid)
        games.append({
            'game_id': sid, 'team_id': team.get('id'), 'team_name': team.get('name'), 'event': st.get('env'),
            'case_id': case, 'case_version': st.get('caseVersion'), 'content_hash': st.get('contentHash'),
            'prompt_version': st.get('promptVersion'), 'model': st.get('model'), 'app_commit': st.get('appCommit'),
            'started_at': st['timestamp'], 'ended_at': (verdict_ev or {}).get('timestamp'),
            'duration_ms': (verdict_ev or {}).get('elapsedMs'), 'practice': practice,
            'outcome': outcome, 'score': v.get('score'), 'total': v.get('total'), 'confidence': v.get('confidence'),
            'roles_guessed': jdump(v.get('roles')), 'roles_true': jdump(truth), 'cast_parts': jdump(cast),
            'character_names': jdump(game_names),
            'questions': sum(e['type'] == 'interview_question' for e in ev),
            'reasoning_inspections': sum(e['type'] == 'reasoning_inspected' for e in ev),
            'talk_lines': sum(e['type'] == 'chatter_line' for e in ev),
            'coins_spent': ((verdict_ev or {}).get('coins') or {}).get('spent'),
            'leaderboard_voided': sid in voided, 'leaderboard_counted': False,
        })
    counted = {s for _, s in first_verdict.values()}
    for g in games:
        g['leaderboard_counted'] = g['game_id'] in counted

    os.makedirs(out, exist_ok=True)
    data = os.path.join(out, 'data')
    os.makedirs(data, exist_ok=True)
    tables = {'games': games, 'interviews': interviews, 'talk_lines': talk, 'llm_calls': calls, 'teams': list(teams.values())}
    for name, rows in tables.items():
        rows.sort(key=lambda r: tuple(str(r.get(k) or '') for k in ('game_id', 'asked_at', 'timestamp', 'started_at', 'created_at')))
        pq.write_table(pa.Table.from_pylist(rows), os.path.join(data, f'{name}.parquet'))

    raw = os.path.join(out, 'raw', event)
    if os.path.exists(raw):
        shutil.rmtree(raw)
    shutil.copytree(event_dir, raw, ignore=shutil.ignore_patterns('content'))
    sums = []
    for f in sorted(glob.glob(os.path.join(raw, '**', '*.jsonl'), recursive=True)):
        sums.append(f'{hashlib.sha256(open(f, "rb").read()).hexdigest()}  {os.path.relpath(f, raw)}')
    open(os.path.join(raw, 'SHA256SUMS'), 'w').write('\n'.join(sums) + '\n')

    stats = summarize(games, interviews, talk, calls, teams)
    json.dump(stats, open(os.path.join(out, 'stats.json'), 'w'), ensure_ascii=False, indent=2)
    open(os.path.join(out, 'README.md'), 'w', encoding='utf-8').write(card(event, stats, voids))
    return stats


def summarize(games, interviews, talk, calls, teams):
    cases = sorted({g['case_id'] for g in games})
    counted = [g for g in games if g['leaderboard_counted']]
    per_case = {}
    for c in cases:
        gs = [g for g in counted if g['case_id'] == c]
        per_case[c] = {
            'games': sum(g['case_id'] == c for g in games), 'counted': len(gs),
            'avg_score': round(sum(g['score'] or 0 for g in gs) / len(gs), 2) if gs else None,
            'total': gs[0]['total'] if gs else None,
            'perfect': sum(1 for g in gs if g['score'] == g['total']),
            'timed_out': sum(1 for g in games if g['case_id'] == c and g['outcome'] == 'timed_out'),
            'questions': sum(1 for i in interviews if i['case_id'] == c),
        }
    durations = sorted(c['duration_ms'] for c in calls if c['duration_ms'] is not None and not c['error'])
    q = lambda p: durations[min(len(durations) - 1, int(p * len(durations)))] if durations else None
    board = {}
    for g in counted:
        b = board.setdefault(g['team_id'], {'team': g['team_name'], 'points': 0, 'coins': 0, 'cases': 0})
        b['points'] += g['score'] or 0
        b['coins'] += g['coins_spent'] or 0
        b['cases'] += 1
    return {
        'teams': len(teams), 'games': len(games), 'games_with_verdict': sum(1 for g in games if g['outcome']),
        'questions': len(interviews), 'talk_lines': len(talk), 'llm_calls': len(calls),
        'llm_errors': sum(1 for c in calls if c['error']),
        'reasoning_inspections': sum(g['reasoning_inspections'] for g in games),
        'models': sorted({c['model'] for c in calls if c['model']}),
        'llm_latency_ms': {'p50': q(.5), 'p90': q(.9), 'max': durations[-1] if durations else None},
        'first_event': min(g['started_at'] for g in games), 'last_event': max((g['ended_at'] or g['started_at']) for g in games),
        'per_case': per_case,
        'leaderboard': sorted(board.values(), key=lambda b: (-b['points'], b['coins'], b['team'])),
    }


def card(event, s, voids):
    lines = [
        '---',
        'pretty_name: Arbiter · IMADA Cup traces',
        'language: [en]',
        'tags: [llm, deception, interrogation, game, traces]',
        'configs:',
    ]
    for name in ('games', 'interviews', 'talk_lines', 'llm_calls', 'teams'):
        lines += [f'- config_name: {name}', '  data_files:', f'  - split: {event.replace("-", "_")}', f'    path: data/{name}.parquet']
    lines += ['---', '', '# Arbiter · IMADA Cup traces', '',
              f'Game logs from **{event}**: teams questioned AI characters (one of them lying) in *The Arbiter* and named each character\'s role.', '',
              '## Contents', '',
              f"- **{s['teams']} teams**, **{s['games']} games**, **{s['questions']} questions**, {s['talk_lines']} talk lines, {s['llm_calls']} model calls ({', '.join(s['models'])}).",
              '- `games`: one row per game, with guessed and true roles, score, coins and whether the leaderboard counted it.',
              '- `interviews`: one row per question, with the character\'s hidden part and role, the answer and the model\'s reasoning.',
              '- `talk_lines`: the characters\' "Let them talk" posts.',
              '- `llm_calls`: every model call, with the full prompt, reply, reasoning and timings.',
              '- `teams`: team id, name and consent version.',
              f'- `raw/{event}/`: the original JSONL logs, with SHA256SUMS.', '',
              '## Consent', '',
              'Every team ticked the check-in box (`research-public-v1`): "I agree that our team name, questions and answers are saved, used in research and made public." No IP addresses, emails or real names are collected.', '',
              '## Known issues', '',
              '- Clocking Out\'s 10-minute clock kept running while a team played another case; a game could time out with no questions (`outcome = timed_out`).',
              '- Clocking Out reasoning is written in ROT13 on purpose (a game mechanic).',
              '- Games started after 17:45 UTC on 2026-11-20 record `app_commit` 6fcf60d but ran 830ac4a (leaderboard fix only).']
    for v in voids:
        lines.append(f"- Leaderboard correction for {v.get('team')}: game {v['sessionId']} voided, {v.get('countInstead')} counted instead. {v.get('reason', '')}")
    lines += ['', 'Internal for now: no license chosen yet.', '']
    return '\n'.join(lines)


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--event-dir', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--push', help='Hugging Face repo id, e.g. my-org/arbiter-imadacup-traces (created private)')
    a = ap.parse_args()
    stats = export(a.event_dir, a.out)
    print(json.dumps({k: stats[k] for k in ('teams', 'games', 'questions', 'talk_lines', 'llm_calls', 'llm_errors')}))
    if a.push:
        from huggingface_hub import HfApi
        api = HfApi()
        api.create_repo(a.push, repo_type='dataset', private=True, exist_ok=True)
        api.upload_folder(repo_id=a.push, repo_type='dataset', folder_path=a.out, ignore_patterns=['stats.json'],
                          commit_message=f'Add {os.path.basename(os.path.normpath(a.event_dir))}')
        print(f'pushed (private): https://huggingface.co/datasets/{a.push}')
