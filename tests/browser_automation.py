"""Automatisation : API fictive, aucune autorisation de trading réelle."""
import functools
import os
import sys
import tempfile
import threading
import zipfile
from http.server import SimpleHTTPRequestHandler,ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from playwright.sync_api import expect,sync_playwright
from tools.build_pages import build


def main():
    with tempfile.TemporaryDirectory() as directory:
        build(Path(directory)/'BDLTradingBot','https://api.example.com')
        server=ThreadingHTTPServer(('127.0.0.1',0),functools.partial(SimpleHTTPRequestHandler,directory=directory))
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        try:
            with sync_playwright() as playwright:
                browser=playwright.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH','/usr/bin/chromium'),headless=True)
                page=browser.new_page(viewport={'width':1440,'height':1000},accept_downloads=True,color_scheme='dark')
                errors=[];page.on('pageerror',lambda error:errors.append(str(error)))
                token='fake-test-only-token-longer-than-32-characters';asset='11111111-1111-4111-8111-111111111111'
                origin=f'http://127.0.0.1:{server.server_port}'
                automation={'settings':{},'currency_id':'22222222-2222-4222-8222-222222222222','strategy':None,'enabled':False,'server_enabled':False,'trading_allowed':False,'points':0,'runs':[],'notes':[],'research':None,'revision':1}
                calls=[]
                def backend(route):
                    path=route.request.url.removeprefix('https://api.example.com');calls.append(path)
                    assert route.request.headers.get('authorization')=='Bearer '+token
                    if path=='/api/session':data={'csrf_token':'fake-session'}
                    elif path=='/api/bitpanda/status':data={'api_key_present':True,'trading_enabled':False,'reason':'Test hors ligne','journal_available':True,'features':{'backtest':False,'automation':True}}
                    elif path=='/api/bitpanda/journal':data={'orders':[]}
                    elif path in ('/api/bitpanda/holdings','/api/bitpanda/currencies'):data={'result':{'data':[]}}
                    elif path.startswith('/api/bitpanda/assets?'):data={'result':{'data':[{'id':asset,'symbol':'BTC','type':'CRYPTO'}]}}
                    elif path=='/api/automation/state':data=automation
                    elif path=='/api/automation/config':
                        automation['settings']=route.request.post_data_json;automation['revision']+=1;data=automation
                    else:raise AssertionError('Unexpected request: '+path)
                    route.fulfill(json=data,headers={'Access-Control-Allow-Origin':origin})
                page.route('https://api.example.com/**',backend)
                page.goto(origin+'/BDLTradingBot/')
                page.locator('#nav-auto').click()
                assert page.locator('#auto-amount').input_value()==''
                assert page.locator('#auto-daily').input_value()==''
                assert page.locator('#auto-enable').is_disabled()
                with page.expect_download() as info:page.get_by_text('Télécharger le coffre Obsidian').click()
                file=Path(directory)/'vault.zip';info.value.save_as(file)
                with zipfile.ZipFile(file) as archive:assert 'Coffre-BDLTradingBot/.obsidian/plugins/bdltradingbot/main.js' in archive.namelist()
                page.locator('.nav[data-view="settings"]').click();page.locator('#server-token').fill(token);page.locator('#server-connect').click()
                expect(page.locator('#server-message')).to_contain_text('compte Bitpanda lu')
                page.locator('#nav-auto').click()
                expect(page.locator('#auto-status')).to_have_text('Ordres automatiques en pause')
                page.locator('#auto-symbol').fill('BTC');page.locator('#auto-search').click();page.locator('#auto-asset').select_option(asset)
                page.locator('#auto-amount').fill('10');page.locator('#auto-daily').fill('50');page.locator('#auto-fee').fill('0.1')
                page.locator('#auto-save').click()
                expect(page.locator('#auto-status-detail')).to_contain_text('collecte doit être autorisée')
                assert automation['settings']['order_amount']=='10';assert not automation['enabled']
                page.locator('#auto-consent').check();assert page.locator('#auto-enable').is_disabled()
                assert '/api/automation/enable' not in calls
                page.screenshot(path='/tmp/bdl-automation-desktop.png',full_page=True)
                page.set_viewport_size({'width':390,'height':844})
                page.screenshot(path='/tmp/bdl-automation-mobile.png',full_page=True)
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
                assert not errors,errors
                browser.close();print('Automatisation : limites vides, sauvegarde, activation interdite, coffre ZIP et mobile validés.')
        finally:server.shutdown();server.server_close();thread.join()


if __name__=='__main__':main()
