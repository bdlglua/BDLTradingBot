import json
import os
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from access import AccessPolicy
from tools.build_pages import build, PUBLIC_FILES
from web import Handler


class PagesBuildTests(unittest.TestCase):
    def test_artifact_contains_only_public_assets_and_is_repeatable(self):
        with tempfile.TemporaryDirectory() as directory:
            site = Path(directory) / 'site'
            build(site, 'https://api.example.com')
            build(site, 'https://api.example.com')
            files = {str(path.relative_to(site)) for path in site.rglob('*') if path.is_file()}
            self.assertEqual(files, set(PUBLIC_FILES) | {'.bdl-pages-build'})
            self.assertIn('"hosted": true', (site/'config.js').read_text())
            self.assertIn('https://api.example.com', (site/'config.js').read_text())
            self.assertNotIn('href="/', (site/'index.html').read_text())
            self.assertNotIn('src="/', (site/'index.html').read_text())

    def test_reject_insecure_or_credential_bearing_api_url(self):
        for url in ('http://api.example.com', 'https://token@api.example.com',
                    'https://api.example.com/?token=secret', 'https://api.example.com/path'):
            with tempfile.TemporaryDirectory() as directory, self.assertRaises(ValueError):
                build(Path(directory)/'site', url)

    def test_does_not_overwrite_unrelated_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            site = Path(directory)/'site'
            site.mkdir(); (site/'user.txt').write_text('Keep this')
            with self.assertRaises(ValueError):
                build(site)
            self.assertEqual((site/'user.txt').read_text(), 'Keep this')


class HostedAPITests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f'http://127.0.0.1:{cls.server.server_port}'

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown(); cls.server.server_close(); cls.thread.join()

    def setUp(self):
        self.token = 'a-test-access-code-with-over-32-characters'
        self.origin = 'https://bdlglua.github.io'
        self.policy = AccessPolicy(self.origin, 'api.example.com', self.token)
        self.patcher = patch.object(Handler, 'access', self.policy)
        self.patcher.start(); self.addCleanup(self.patcher.stop)

    def headers(self):
        return {'Host': 'api.example.com', 'Origin': self.origin, 'Authorization': 'Bearer '+self.token}

    def test_authenticated_session_and_cors(self):
        with urlopen(Request(self.base+'/api/session', headers=self.headers()), timeout=5) as response:
            self.assertEqual(response.headers['Access-Control-Allow-Origin'], self.origin)
            self.assertIn('csrf_token', json.load(response))

    def test_private_routes_require_authentication(self):
        for path in ('/api/session', '/api/bitpanda/status', '/api/bitpanda/holdings'):
            headers = self.headers(); headers.pop('Authorization')
            with self.assertRaises(HTTPError) as error:
                urlopen(Request(self.base+path, headers=headers), timeout=5)
            self.assertEqual(error.exception.code, 401)

    def test_valid_token_cannot_override_origin_restriction(self):
        headers = dict(self.headers(), Origin='https://attacker.example')
        with self.assertRaises(HTTPError) as error:
            urlopen(Request(self.base+'/api/session', headers=headers), timeout=5)
        self.assertEqual(error.exception.code, 403)
        self.assertIsNone(error.exception.headers.get('Access-Control-Allow-Origin'))

    def test_preflight_allows_only_expected_headers_and_origin(self):
        headers = self.headers(); headers.pop('Authorization')
        headers.update({'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'Authorization, Content-Type, X-CSRF-Token'})
        with urlopen(Request(self.base+'/api/bitpanda/accept', headers=headers, method='OPTIONS'), timeout=5) as response:
            self.assertEqual(response.status, 204)
            self.assertEqual(response.headers['Access-Control-Allow-Origin'], self.origin)
        headers['Origin'] = 'https://attacker.example'
        with self.assertRaises(HTTPError) as error:
            urlopen(Request(self.base+'/api/bitpanda/accept', headers=headers, method='OPTIONS'), timeout=5)
        self.assertEqual(error.exception.code, 403)

    def test_health_does_not_expose_account_data(self):
        headers = self.headers(); headers.pop('Authorization')
        with urlopen(Request(self.base+'/health', headers=headers), timeout=5) as response:
            self.assertEqual(json.load(response), {'status':'ok'})

    def test_public_configuration_requires_https_and_strong_token(self):
        settings = {'DASHBOARD_PUBLIC_ORIGIN': self.origin, 'DASHBOARD_API_HOST': 'api.example.com',
                    'DASHBOARD_ACCESS_TOKEN': self.token}
        with patch.dict(os.environ, settings, clear=True):
            self.assertTrue(AccessPolicy.from_environment().public)
        for change in ({'DASHBOARD_PUBLIC_ORIGIN': 'http://bdlglua.github.io'},
                       {'DASHBOARD_PUBLIC_ORIGIN': self.origin+'/BDLTradingBot/'},
                       {'DASHBOARD_ACCESS_TOKEN': 'short'}, {'DASHBOARD_API_HOST': ''}):
            with patch.dict(os.environ, dict(settings, **change), clear=True), self.assertRaises(ValueError):
                AccessPolicy.from_environment()
