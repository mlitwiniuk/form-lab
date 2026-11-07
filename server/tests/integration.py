#!/usr/bin/env python3
"""Exercise the real HTTP server, account isolation and SQLite persistence."""
import http.cookiejar
import json
import os
import socket
import sqlite3
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BINARY = ROOT / 'server/target/debug/form-lab-server'
with socket.socket() as sock:
    sock.bind(('127.0.0.1', 0))
    port = sock.getsockname()[1]
origin = f'http://127.0.0.1:{port}'
key = 'integration-signup-secret-123'
with tempfile.TemporaryDirectory() as tmp:
    env = dict(os.environ, FORM_LAB_BIND=f'127.0.0.1:{port}', FORM_LAB_ORIGIN=origin, FORM_LAB_SIGNUP_KEY=key, FORM_LAB_DATABASE=f'{tmp}/db.sqlite3', FORM_LAB_ASSETS=str(ROOT / 'frontend/dist'))
    def launch():
        proc = subprocess.Popen([str(BINARY)], cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        for _ in range(100):
            try:
                urllib.request.urlopen(origin + '/', timeout=1).close()
                return proc
            except (OSError, urllib.error.URLError):
                if proc.poll() is not None:
                    raise RuntimeError(proc.stderr.read().decode())
                time.sleep(.05)
        raise RuntimeError('server did not start')
    def client():
        return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    def call(opener, path, method='GET', body=None, request_origin=origin):
        data = json.dumps(body).encode() if body is not None else None
        headers = {'Origin': request_origin}
        if data is not None: headers['Content-Type'] = 'application/json'
        req = urllib.request.Request(origin + path, data=data, headers=headers, method=method)
        try:
            with opener.open(req, timeout=10) as response:
                content = response.read()
                return response.status, json.loads(content) if content else None
        except urllib.error.HTTPError as e:
            return e.code, e.read().decode()
    proc = launch()
    try:
        with urllib.request.urlopen(origin+'/sketchfab/') as response:
            assert b'Sketchfab sketch reference' in response.read()
        a, b = client(), client()
        cred = lambda n: {'username':n, 'password':'very-long-password-123', 'signup_key':key}
        assert call(a, '/api/register', 'POST', {**cred('alice'), 'signup_key':'wrong'})[0] == 403
        assert call(a, '/api/register', 'POST', cred('alice'))[0] == 200
        assert call(b, '/api/register', 'POST', cred('bobby'))[0] == 200
        with a.open(origin+'/api/me') as response:
            assert response.headers['Cache-Control'] == 'no-store'
            assert response.headers['Vary'] == 'Cookie'
        with a.open(origin+'/up') as response:
            assert response.read() == b'ok'
        assert call(a, '/api/missing')[0] == 404
        for path in ['/api/register', '/api/login', '/api/logout', '/api/models']:
            assert call(a, path, 'POST', {'uid':'x','title':'x'} if path == '/api/models' else cred('alice'), 'https://evil.example')[0] == 403
        assert call(a, '/api/logout', 'POST', {}, '')[0] == 403
        assert call(client(), '/api/models')[0] == 401
        assert call(client(), '/api/models', 'POST', {'uid':'x','title':'x'})[0] == 401
        assert call(a, '/api/models', 'POST', {'uid':'abcd1234','title':'Study'}, 'https://evil.example')[0] == 403
        assert call(a, '/api/models', 'POST', {'uid':'abcd1234','title':'Study'})[0] == 200
        assert call(a, '/api/models')[1] == [{'uid':'abcd1234','title':'Study'}]
        assert call(b, '/api/models')[1] == []
        assert call(b, '/api/models', 'POST', {'uid':'abcd1234','title':'Bobby study'})[0] == 200
        assert call(a, '/api/models')[1] == [{'uid':'abcd1234','title':'Study'}]
        assert call(b, '/api/models/abcd1234', 'DELETE')[0] == 200
        assert len(call(a, '/api/models')[1]) == 1
        other_device=client()
        assert call(other_device, '/api/login', 'POST', cred('alice'))[0] == 200
        # Inspect the real cookie flags and verify logout revokes a copied token.
        login_req = urllib.request.Request(origin+'/api/login', data=json.dumps(cred('alice')).encode(), headers={'Origin':origin,'Content-Type':'application/json'})
        with a.open(login_req) as response:
            cookie=response.headers['Set-Cookie']
            assert 'HttpOnly' in cookie and 'SameSite=Strict' in cookie and 'Max-Age=2592000' in cookie
        raw_cookie=cookie.split(';')[0]
        with sqlite3.connect(f'{tmp}/db.sqlite3') as db:
            hashes=[row[0] for row in db.execute('SELECT token_hash FROM sessions')]
            assert raw_cookie.split('=')[1] not in hashes
        assert call(a, '/api/logout', 'POST', {})[0] == 200
        try:
            urllib.request.urlopen(urllib.request.Request(origin+'/api/models', headers={'Cookie':raw_cookie}))
            raise AssertionError('revoked session accepted')
        except urllib.error.HTTPError as error:
            assert error.code == 401
        assert call(a, '/api/models')[0] == 401
        assert call(other_device, '/api/models')[1] == [{'uid':'abcd1234','title':'Study'}]
        assert call(a, '/api/login', 'POST', {'username':'alice','password':'wrong'})[0] == 401
        assert call(a, '/api/login', 'POST', cred('alice'))[0] == 200
        backup=f'{tmp}/backup.sqlite3'
        subprocess.run([str(BINARY), 'backup', backup], env=env, check=True)
        assert os.stat(backup).st_mode & 0o777 == 0o600
        assert subprocess.run([str(BINARY), 'backup', backup], env=env, stderr=subprocess.DEVNULL).returncode != 0
        with sqlite3.connect(backup) as db:
            assert db.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
            assert db.execute('SELECT COUNT(*) FROM models').fetchone()[0] == 1
        proc.terminate(); proc.wait(timeout=5)
        proc=launch()
        assert call(a, '/api/models')[1] == [{'uid':'abcd1234','title':'Study'}]
        proc.terminate(); proc.wait(timeout=5)
        # Restore a snapshot into a separate path and start with registration disabled.
        env['FORM_LAB_DATABASE']=backup
        env['FORM_LAB_SIGNUP_KEY']=''
        proc = launch()
        assert call(client(), '/api/register', 'POST', cred('charlie'))[0] == 403
        assert call(a, '/api/models')[1] == [{'uid':'abcd1234','title':'Study'}]
        assert call(a, '/api/models/abcd1234', 'DELETE')[0] == 200
        assert call(a, '/api/models')[1] == []
        # An expired token must fail even when its cookie is still presented.
        with sqlite3.connect(backup) as db:
            db.execute('UPDATE sessions SET expires_at=0')
        assert call(a, '/api/models')[0] == 401
        for _ in range(8):
            assert call(client(), '/api/login', 'POST', {'username':'unknown', 'password':'wrong'})[0] == 401
        assert call(client(), '/api/login', 'POST', {'username':'unknown', 'password':'wrong'})[0] == 429
        proc.terminate(); proc.wait(timeout=5)
        secure_origin='https://form-lab.example.test'
        env['FORM_LAB_ORIGIN']=secure_origin
        proc=launch()
        secure_req=urllib.request.Request(origin+'/api/login', data=json.dumps(cred('alice')).encode(), headers={'Origin':secure_origin,'Content-Type':'application/json'})
        with urllib.request.urlopen(secure_req) as response:
            cookie=response.headers['Set-Cookie']
            assert cookie.startswith('__Host-formlab_session=') and '; Secure' in cookie and 'Domain=' not in cookie
        raw=cookie.split(';')[0]
        req=urllib.request.Request(origin+'/api/models', headers={'Cookie':raw})
        with urllib.request.urlopen(req) as response: assert response.status == 200
        logout_req=urllib.request.Request(origin+'/api/logout', data=b'{}', headers={'Origin':secure_origin,'Content-Type':'application/json','Cookie':raw})
        with urllib.request.urlopen(logout_req) as response:
            cookie=response.headers['Set-Cookie']
            assert cookie.startswith('__Host-formlab_session=;') and '; Secure' in cookie and 'Max-Age=0' in cookie
        print('Accounts, cookie flags/revocation/expiry, CSRF, isolation, throttling, backup/restore and restart checks passed.')
    finally:
        proc.terminate(); proc.wait(timeout=5)
