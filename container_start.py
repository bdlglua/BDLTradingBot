"""Prépare le disque persistant puis abandonne les privilèges root."""
import os
import sys
from pathlib import Path


def main():
    directory = Path(os.environ.get('BITPANDA_STATE_DIR', '/data'))
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    if os.getuid() == 0:
        os.chown(directory, 10001, 10001)
        for name in ('bitpanda.sqlite3', 'bitpanda.sqlite3-journal', 'bitpanda.sqlite3-wal', 'bitpanda.sqlite3-shm'):
            path = directory / name
            if path.is_symlink():
                raise SystemExit('Journal symbolique refusé.')
            if path.exists():
                os.chown(path, 10001, 10001)
        os.setgroups([])
        os.setgid(10001)
        os.setuid(10001)
    os.execv(sys.executable, [sys.executable, 'web.py', '--host', '0.0.0.0'])


if __name__ == '__main__':
    main()
