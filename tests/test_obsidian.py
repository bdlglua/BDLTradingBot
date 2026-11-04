import io
import json
import unittest
import zipfile

from tools.vault_export import starter_zip


class ObsidianTests(unittest.TestCase):
    def test_vault_is_openable_without_credentials_or_enabled_plugins(self):
        with zipfile.ZipFile(io.BytesIO(starter_zip())) as archive:
            names=archive.namelist()
            self.assertIn('Coffre-BDLTradingBot/BDLTradingBot/Fonctionnement.md',names)
            self.assertIn('Coffre-BDLTradingBot/BDLTradingBot/Strategies/Exemple.md',names)
            self.assertNotIn('Coffre-BDLTradingBot/.obsidian/community-plugins.json',names)
            self.assertTrue(all(name.startswith('Coffre-BDLTradingBot/') and '..' not in name.split('/') for name in names))
            manifest=json.loads(archive.read('Coffre-BDLTradingBot/.obsidian/plugins/bdltradingbot/manifest.json'))
            self.assertEqual(manifest['id'],'bdltradingbot')
            self.assertIn('Aucune donnée',archive.read('Coffre-BDLTradingBot/BDLTradingBot/Journal.md').decode())
