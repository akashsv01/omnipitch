"""Optional live HTTP smoke check; run from repository root with ports 8000/5173 free."""
from pathlib import Path
import json
import os
import shutil
import subprocess
import sys
import time
from urllib.request import urlopen, Request
from jsonschema import Draft202012Validator, FormatChecker

root=Path.cwd()
processes=[]
def get(url):
    with urlopen(url, timeout=30) as response:
        assert response.status==200
        return response.read()
def wait_for(url, process):
    for _ in range(100):
        if process.poll() is not None:
            raise RuntimeError(f'Server exited: {url}')
        try: return get(url)
        except (OSError, TimeoutError): time.sleep(.1)
    raise RuntimeError(f'Server not ready: {url}')
(root/'data/generated').mkdir(parents=True,exist_ok=True)
try:
    with (root/'data/generated/smoke-api.log').open('w') as api_log, (root/'data/generated/smoke-web.log').open('w') as web_log:
        api=subprocess.Popen([sys.executable,'-m','uvicorn','app.main:app','--app-dir','services/api','--host','localhost','--port','8000'],cwd=root,env=dict(os.environ,CORS_ORIGINS='http://localhost:5173'),stdout=api_log,stderr=subprocess.STDOUT)
        processes.append(api)
        health=json.loads(wait_for('http://localhost:8000/health',api))
        assert health['status']=='ok'
        state=json.loads(get('http://localhost:8000/api/v1/matches/demo/state'))
        events=json.loads(get('http://localhost:8000/api/v1/matches/demo/events'))['events']
        for name,records in [('match-state',[state]),('event',events)]:
            schema=json.loads((root/f'contracts/schemas/{name}.schema.json').read_text())
            check=Draft202012Validator(schema,format_checker=FormatChecker())
            for record in records: check.validate(record)
        with urlopen(Request('http://localhost:8000/health',headers={'Origin':'http://localhost:5173'}),timeout=30) as response:
            assert response.headers['access-control-allow-origin']=='http://localhost:5173'
        web=subprocess.Popen([shutil.which('node'),str(root/'apps/web/node_modules/vite/bin/vite.js'),'--host','localhost'],cwd=root/'apps/web',stdout=web_log,stderr=subprocess.STDOUT)
        processes.append(web)
        assert b'OmniPitch' in wait_for('http://localhost:5173/',web)
        assert b'http://localhost:8000' in get('http://localhost:5173/src/lib/api.ts')
        get('http://localhost:5173/src/App.tsx')
        # Transform the actual shared JSON schemas imported by the browser module.
        for name in ['event','match-state']:
            get('http://localhost:5173/@fs/'+(root/f'contracts/schemas/{name}.schema.json').as_posix()+'?import')
        subprocess.run([sys.executable,'-m','simulator.generate','--seed','7','--run-id','demo-run-001','--output','data/generated/demo.jsonl'],cwd=root,env=dict(os.environ,PYTHONPATH=str(root/'services/simulator')),check=True)
        print('PASS: live HTTP health/state/events, schema validation, explicit CORS, Vite HTML/modules/shared schema imports, simulator CLI')
finally:
    for process in reversed(processes):
        process.terminate()
        try: process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill();process.wait()
