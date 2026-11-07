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
        # The library supports distinct named settings for both tools, not one row per UID.
        assert call(client(), '/api/configurations')[0] == 401
        assert call(a, '/api/account-options')[1] == {'signup_enabled':True}
        shape={'kind':'box','size':[3,3,3],'position':[0,0,0],'rotation':[0,0,0],'deform':{'twist':0,'bend':0,'taper':0,'bulge':0,'roundness':0}}
        study={'version':5,'display':'wireframe','scene':{'a':shape,'b':shape,'operation':'single','contours':4},'camera':{'position':[10,10,10],'target':[0,0,0],'projection':'orthographic','orthographicSpan':12,'orbitMode':'turn'},'reveals':{'construction':True,'hidden':False,'cutter':False,'seam':False},'locked':True,'focus':False}
        model={'version':1,'uid':'abcd1234','projection':'wide','fov':85,'position':[12,-24,18],'target':[1,2,3],'step':15,'locked':True}
        study_body={'title':'Form study','kind':'study','settings':study}
        model_body={'title':'Front view','kind':'sketchfab','settings':model}
        assert call(a, '/api/configurations', 'POST', model_body, 'https://evil.example')[0] == 403
        assert call(a, '/api/configurations', 'POST', {**model_body,'kind':'unknown'})[0] == 422
        assert call(a, '/api/configurations', 'POST', {**model_body,'title':' '})[0] == 400
        assert call(a, '/api/configurations', 'POST', {**model_body,'settings':{'version':1,'uid':'../bad'}})[0] == 400
        form_save=call(a, '/api/configurations', 'POST', study_body)[1]
        front=call(a, '/api/configurations', 'POST', model_body)[1]
        side=call(a, '/api/configurations', 'POST', {**model_body,'title':'Side view'})[1]
        assert front['id'] != side['id']
        assert call(a, '/api/configurations/'+form_save['id'])[1]['settings'] == study
        assert call(a, '/api/configurations/'+front['id'])[1]['settings'] == model
        assert call(b, '/api/configurations')[1] == []
        for method,body in [('GET',None),('PUT',{**model_body,'expected_revision':1}),('DELETE',None)]:
            assert call(b, '/api/configurations/'+front['id'], method, body)[0] == 404
        updated=call(a, '/api/configurations/'+front['id'], 'PUT', {**model_body,'title':'Updated view','expected_revision':1})[1]
        assert updated['revision'] == 2 and updated['id'] == front['id']
        assert call(a, '/api/configurations/'+front['id'], 'PUT', {**model_body,'expected_revision':1})[0] == 409
        assert call(a, '/api/configurations/'+front['id'], 'PUT', model_body)[0] == 400
        assert call(a, '/api/configurations/'+front['id'], 'PUT', {**study_body,'expected_revision':2})[0] == 409
        assert call(a, '/api/configurations/'+front['id'])[1]['title'] == 'Updated view'
        assert call(a, '/api/configurations/'+side['id'], 'DELETE')[0] == 200
        assert len(call(a, '/api/configurations')[1]) == 2
        assert all('settings' not in row for row in call(a, '/api/configurations')[1])
        backup=f'{tmp}/backup.sqlite3'
        subprocess.run([str(BINARY), 'backup', backup], env=env, check=True)
        assert os.stat(backup).st_mode & 0o777 == 0o600
        assert subprocess.run([str(BINARY), 'backup', backup], env=env, stderr=subprocess.DEVNULL).returncode != 0
        with sqlite3.connect(backup) as db:
            assert db.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
            assert db.execute('SELECT COUNT(*) FROM models').fetchone()[0] == 1
            assert db.execute('SELECT COUNT(*) FROM configurations').fetchone()[0] == 2
        proc.terminate(); proc.wait(timeout=5)
        proc=launch()
        assert call(a, '/api/models')[1] == [{'uid':'abcd1234','title':'Study'}]
        proc.terminate(); proc.wait(timeout=5)
        # Restore a snapshot into a separate path and start with registration disabled.
        env['FORM_LAB_DATABASE']=backup
        env['FORM_LAB_SIGNUP_KEY']=''
        proc = launch()
        assert call(client(), '/api/register', 'POST', cred('charlie'))[0] == 403
        assert call(a, '/api/account-options')[1] == {'signup_enabled':False}
        assert call(a, '/api/configurations/'+form_save['id'])[1]['settings'] == study
        assert call(a, '/api/configurations/'+front['id'])[1]['revision'] == 2
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
        # Password rotation revokes every old device session, then issues a fresh session.
        changed={'current_password':'very-long-password-123','new_password':'updated-long-password-456'}
        assert call(a, '/api/password', 'POST', changed, 'https://evil.example')[0] == 403
        raw_headers={'Origin':secure_origin,'Content-Type':'application/json','Cookie':raw}
        wrong=urllib.request.Request(origin+'/api/password',data=json.dumps({**changed,'current_password':'wrong'}).encode(),headers=raw_headers)
        try: urllib.request.urlopen(wrong); raise AssertionError('wrong current password accepted')
        except urllib.error.HTTPError as error: assert error.code == 401
        change_req=urllib.request.Request(origin+'/api/password',data=json.dumps(changed).encode(),headers=raw_headers)
        with urllib.request.urlopen(change_req) as response:
            new_cookie=response.headers['Set-Cookie'].split(';')[0]
            assert new_cookie != raw
        try: urllib.request.urlopen(req); raise AssertionError('old session survived password rotation')
        except urllib.error.HTTPError as error: assert error.code == 401
        with urllib.request.urlopen(urllib.request.Request(origin+'/api/me', headers={'Cookie':new_cookie})) as response: assert response.status == 200
        assert call(client(), '/api/login', 'POST', cred('alice'), secure_origin)[0] == 401
        assert call(client(), '/api/login', 'POST', {**cred('alice'),'password':'updated-long-password-456'}, secure_origin)[0] == 200
        logout_req=urllib.request.Request(origin+'/api/logout', data=b'{}', headers={'Origin':secure_origin,'Content-Type':'application/json','Cookie':new_cookie})
        with urllib.request.urlopen(logout_req) as response:
            cookie=response.headers['Set-Cookie']
            assert cookie.startswith('__Host-formlab_session=;') and '; Secure' in cookie and 'Max-Age=0' in cookie
        print('Accounts/password rotation, saved study/model settings, overwrite conflicts, isolation, CSRF, throttling, backup/restore and restart checks passed.')
    finally:
        proc.terminate(); proc.wait(timeout=5)
