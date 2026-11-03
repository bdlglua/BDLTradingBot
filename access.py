"""Contrôles d'accès du serveur local ou du backend HTTPS hébergé."""
import os
import secrets
from dataclasses import dataclass, field
from urllib.parse import urlsplit


@dataclass(frozen=True)
class AccessPolicy:
    origin: str = ''
    host: str = ''
    token: str = field(default='', repr=False)

    @classmethod
    def from_environment(cls):
        origin = os.environ.get('DASHBOARD_PUBLIC_ORIGIN', '').rstrip('/')
        host = os.environ.get('DASHBOARD_API_HOST', '') or os.environ.get('RENDER_EXTERNAL_HOSTNAME', '')
        token = os.environ.get('DASHBOARD_ACCESS_TOKEN', '')
        if not origin and not host and not token:
            return cls()
        parsed = urlsplit(origin)
        if parsed.scheme != 'https' or not parsed.hostname or parsed.netloc != parsed.hostname or parsed.path or parsed.query or parsed.fragment:
            raise ValueError('DASHBOARD_PUBLIC_ORIGIN doit être une origine HTTPS exacte, sans chemin ni port.')
        if not host or any(character not in 'abcdefghijklmnopqrstuvwxyz0123456789.-' for character in host) or '.' not in host:
            raise ValueError('DASHBOARD_API_HOST doit être le nom DNS exact du backend.')
        if len(token) < 32 or len(token) > 256 or not token.isascii() or any(char.isspace() for char in token):
            raise ValueError('DASHBOARD_ACCESS_TOKEN doit contenir entre 32 et 256 caractères ASCII sans espaces.')
        return cls(origin, host, token)

    @property
    def public(self):
        return bool(self.origin)

    def permits_request(self, headers, port):
        host, origin = headers.get('Host', ''), headers.get('Origin')
        if self.public:
            return host == self.host and (origin is None or origin == self.origin)
        return (host in {f'127.0.0.1:{port}', f'localhost:{port}'}
                and headers.get('Sec-Fetch-Site') != 'cross-site'
                and (origin is None or origin == 'http://' + host))

    def authenticated(self, headers):
        if not self.public:
            return True
        supplied = headers.get('Authorization', '')
        return supplied.isascii() and secrets.compare_digest(supplied, 'Bearer ' + self.token)
