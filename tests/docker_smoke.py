"""Test Docker facultatif, sans clé Bitpanda ni déploiement distant.

Construire préalablement l'image bdltradingbot:pages avec le moteur local.
"""
import json
import os
import secrets
import subprocess
import time
import urllib.error
import urllib.request


def main():
    base = ['env', '-u', 'DOCKER_HOST', '-u', 'DOCKER_CONTEXT', '-u', 'DOCKER_TLS',
            '-u', 'DOCKER_TLS_VERIFY', '-u', 'DOCKER_CERT_PATH', 'docker',
            '--host=unix:///var/run/docker.sock']
    name = 'bdl-pages-smoke-' + secrets.token_hex(4)
    volume = name + '-data'
    token = secrets.token_urlsafe(48)
    child_env = dict(os.environ, DASHBOARD_ACCESS_TOKEN=token)
    def docker(*args):
        return subprocess.check_output(base + list(args), text=True, env=child_env).strip()
    def request(path, authenticated=True):
        headers = {'Host': 'api.example.com', 'Origin': 'https://bdlglua.github.io'}
        if authenticated:
            headers['Authorization'] = 'Bearer ' + token
        with urllib.request.urlopen(urllib.request.Request(url + path, headers=headers), timeout=5) as response:
            assert response.headers.get('Access-Control-Allow-Origin') == 'https://bdlglua.github.io'
            return json.load(response)
    def ready():
        for _ in range(60):
            try:
                assert request('/health', False) == {'status': 'ok'}
                return
            except (OSError, AssertionError):
                time.sleep(.1)
        raise RuntimeError('Serveur conteneur indisponible.')
    try:
        docker('run', '-d', '--name', name, '-p', '127.0.0.1::8000', '--mount',
               'type=volume,src=' + volume + ',dst=/data',
               '-e', 'DASHBOARD_PUBLIC_ORIGIN=https://bdlglua.github.io',
               '-e', 'DASHBOARD_API_HOST=api.example.com', '-e', 'DASHBOARD_ACCESS_TOKEN',
               '-e', 'BITPANDA_ENABLE_TRADING=0', 'bdltradingbot:pages')
        port = docker('inspect', '--format', '{{(index (index .NetworkSettings.Ports "8000/tcp") 0).HostPort}}', name)
        url = 'http://127.0.0.1:' + port
        ready()
        try:
            request('/api/session', False)
            raise AssertionError('Authentification manquante acceptée.')
        except urllib.error.HTTPError as error:
            assert error.code == 401
        status = request('/api/bitpanda/status')
        assert not status['api_key_present'] and not status['trading_enabled']
        assert request('/api/bitpanda/journal') == {'orders': []}
        uid = docker('exec', name, 'python', '-c', "import os; print(os.stat('/data/bitpanda.sqlite3').st_uid)")
        assert uid == '10001'
        process_uid = docker('exec', name, 'python', '-c', "from pathlib import Path; print(next(s for s in Path('/proc/1/status').read_text().splitlines() if s.startswith('Uid:')).split()[1])")
        assert process_uid == '10001'
        docker('restart', '-t', '1', name)
        port = docker('inspect', '--format', '{{(index (index .NetworkSettings.Ports "8000/tcp") 0).HostPort}}', name)
        url = 'http://127.0.0.1:' + port
        ready()
        assert request('/api/bitpanda/journal') == {'orders': []}
        print('Docker : santé, authentification, CORS, absence de clé Bitpanda, UID 10001 et disque après redémarrage validés.')
    except Exception:
        subprocess.run(base + ['logs', name], check=False)
        raise
    finally:
        subprocess.run(base + ['rm', '-f', name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        subprocess.run(base + ['volume', 'rm', volume], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


if __name__ == '__main__':
    main()
