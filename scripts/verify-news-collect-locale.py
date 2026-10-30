#!/usr/bin/env python3
"""Offline regression for the pilot collector locale bug. Stub collectors; never reads real subscriptions."""
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

RISK = re.compile(r'\$[A-Za-z_][A-Za-z0-9_]*[^\x00-\x7f]')


def main() -> int:
    script = Path(sys.argv[1]).resolve()
    source = script.read_text(encoding='utf-8')
    project = script.parent.parent
    old_line = 'fetch=$fetch_status）'
    new_line = 'fetch=${fetch_status}）'
    if old_line not in source and new_line not in source:
        raise SystemExit('expected collector completion line missing')
    original = source.replace(new_line, old_line)
    fixed = source.replace(old_line, new_line)

    source_checks = []
    for rel in ['scripts/collect.sh', 'scripts/render.sh',
                'scripts/news-collector/collect-with-fallback.sh']:
        path = project / rel
        text = path.read_text(encoding='utf-8')
        hits = [f'{i}: {line.strip()}' for i, line in enumerate(text.splitlines(), 1) if RISK.search(line)]
        assert not hits, (rel, hits)
        source_checks.append({'file': str(path), 'riskyPatterns': hits})
    assert old_line not in source, 'real project collector still has unbraced completion line'

    results = []
    for shell in dict.fromkeys([shutil.which('bash'), '/bin/bash']):
        for locale in ['C', 'en_US.UTF-8']:
            for version, body in [('before', original), ('after', fixed)]:
                for mode in ['live-fixture', 'degraded-fixture', 'extract-failed-fixture']:
                    with tempfile.TemporaryDirectory(prefix='orch-collector-regression-') as tmp:
                        root = Path(tmp)
                        collector = root / 'scripts/news-collector'
                        collector.mkdir(parents=True)
                        (root / '.news-db').mkdir()
                        (root / '.news-db/sources.json').write_text('{"sources":[]}')
                        fixture = root / 'scripts/collect.sh'
                        fixture.write_text(body)
                        (collector / 'collect-with-fallback.sh').write_text(
                            'exit ' + ('1' if mode == 'degraded-fixture' else '0') + '\n')
                        if mode == 'extract-failed-fixture':
                            extractor = 'raise SystemExit(2)\n'
                        else:
                            extractor = (
                                'import os, pathlib\n'
                                "p = pathlib.Path(os.environ['NEWS_DB_DIR']) / 'summaries'\n"
                                "p.mkdir(exist_ok=True)\n"
                                "(p / ('rolling_summary_fixture_' + os.environ['NEWS_SUMMARY_TAG'] + '.md'))"
                                ".write_text('# Synthetic summary\\nNo live data.\\n')\n"
                            )
                        (collector / 'news_db_extract.py').write_text(extractor)
                        env = {'PATH': os.environ['PATH'], 'LANG': locale, 'LC_ALL': locale,
                               'NEWS_FOCUS_DIMENSION': 'general', 'NEWS_AUDIENCE': 'fixture'}
                        proc = subprocess.run([shell, str(fixture)], env=env, capture_output=True, timeout=10)
                        meta_path = root / 'artifacts/collect/meta.json'
                        if mode == 'extract-failed-fixture':
                            assert proc.returncode == 1, (shell, locale, version, mode, proc.returncode, proc.stderr)
                            meta = json.loads(meta_path.read_text(encoding='utf-8'))
                            assert meta['status'] == 'extract-failed'
                            expected = 1
                        elif version == 'before' and locale != 'C':
                            assert proc.returncode != 0, (shell, locale, version, mode, proc.returncode, proc.stderr)
                            assert b'unbound variable' in proc.stderr
                            meta = json.loads(meta_path.read_text(encoding='utf-8'))
                            data = (root / 'artifacts/collect/summary.md').read_bytes()
                            assert meta['sha256'] == hashlib.sha256(data).hexdigest()
                            assert meta['status'] == ('degraded-cache' if mode == 'degraded-fixture' else 'ok')
                            expected = 'nonzero'
                        else:
                            assert proc.returncode == 0, (shell, locale, version, mode, proc.returncode, proc.stderr)
                            meta = json.loads(meta_path.read_text(encoding='utf-8'))
                            data = (root / 'artifacts/collect/summary.md').read_bytes()
                            assert meta['sha256'] == hashlib.sha256(data).hexdigest()
                            assert meta['status'] == ('degraded-cache' if mode == 'degraded-fixture' else 'ok')
                            expected = 0
                        results.append({'shell': shell, 'locale': locale, 'version': version, 'mode': mode,
                                        'exitCode': proc.returncode, 'expectedExit': expected})
    print(json.dumps({'status': 'PASS', 'networkCalls': 0, 'realNewsRuns': 0,
                      'sourceChecks': source_checks, 'cases': results}, ensure_ascii=False, indent=2))
    return 0


if __name__ == '__main__':
    sys.exit(main())
