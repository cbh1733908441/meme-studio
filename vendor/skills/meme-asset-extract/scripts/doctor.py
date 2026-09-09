"""Report actual runtime readiness without printing keys or browser credentials."""
import argparse,asyncio,importlib.metadata,importlib.util,json,pathlib,platform,shutil,subprocess,sys

async def browser_check():
    from playwright.async_api import async_playwright
    async with async_playwright() as p:
        browser=await p.chromium.launch(headless=True)
        version=browser.version;await browser.close();return {'status':'passed','version':version}

def inspect(check_browser=False,check_gemini=False):
    data={'python':platform.python_version(),'os':platform.system(),'packages':{},'tools':{},'browser':{'status':'not_tested'},'gemini':{}}
    for name in ['playwright','requests','keyring','yt-dlp']:
        try:data['packages'][name]=importlib.metadata.version(name)
        except importlib.metadata.PackageNotFoundError:data['packages'][name]='missing'
    for name in ['ffmpeg','ffprobe']:
        if not shutil.which(name):data['tools'][name]='missing';continue
        r=subprocess.run([name,'-version'],capture_output=True,text=True,encoding='utf8',errors='replace',timeout=10)
        data['tools'][name]=r.stdout.splitlines()[0] if r.returncode==0 else 'failed'
    try:
        import gemini_media
        key=gemini_media.secret();model=gemini_media.config().get('model',gemini_media.DEFAULT_MODEL)
        data['gemini']={'key_configured':bool(key),'model':model,'access':'not_tested'}
        if check_gemini and key:
            gemini_media.call('GET','/models/'+model,key);data['gemini']['access']='passed'
        elif check_gemini:data['gemini']['access']='configuration_required'
    except Exception as e:data['gemini']['error']=str(e) if isinstance(e,RuntimeError) and str(e).startswith('Gemini HTTP ') else type(e).__name__
    if check_browser:
        try:data['browser']=asyncio.run(browser_check())
        except Exception as e:data['browser']={'status':'failed','error':type(e).__name__,'next':'Install Playwright Chromium and check that this execution identity can launch it; compare with a normal terminal.'}
    data['ready_for_gemini_pipeline']=all(v!='missing' for v in data['packages'].values()) and all(v not in ('missing','failed') for v in data['tools'].values()) and data['gemini'].get('key_configured',False) and not data['gemini'].get('error') and (not check_browser or data['browser']['status']=='passed') and (not check_gemini or data['gemini'].get('access')=='passed')
    data['limits']='Configuration and launch checks do not prove site access or media understanding. Compare this report in your terminal and your Agent execution environment.'
    return data

if __name__=='__main__':
    if hasattr(sys.stdout,'reconfigure'):sys.stdout.reconfigure(encoding='utf8',errors='replace')
    p=argparse.ArgumentParser();p.add_argument('--check-browser',action='store_true');p.add_argument('--check-gemini',action='store_true');p.add_argument('--out')
    a=p.parse_args();result=inspect(a.check_browser,a.check_gemini)
    if a.out:
        dest=pathlib.Path(a.out);dest.parent.mkdir(parents=True,exist_ok=True);dest.write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf8')
    print(json.dumps(result,ensure_ascii=False,indent=2));raise SystemExit(0 if result['ready_for_gemini_pipeline'] else 2)
