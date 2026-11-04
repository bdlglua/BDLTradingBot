"""Coffre initial Obsidian, sans donnée de compte ni secret."""
import io
import zipfile
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]


def starter_zip():
    output=io.BytesIO()
    with zipfile.ZipFile(output,'w',zipfile.ZIP_DEFLATED) as archive:
        for file in sorted((ROOT/'vault').rglob('*.md')):
            archive.write(file,'Coffre-BDLTradingBot/'+str(file.relative_to(ROOT/'vault')))
        for name in ('manifest.json','main.js'):
            archive.write(ROOT/'obsidian-plugin'/name,'Coffre-BDLTradingBot/.obsidian/plugins/bdltradingbot/'+name)
        # Installed but deliberately not enabled: the owner chooses to trust the plugin.
    return output.getvalue()
