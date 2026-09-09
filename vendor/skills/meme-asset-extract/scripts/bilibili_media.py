"""Acquire the currently playable Bilibili stream using its own browser session.

Extracted from the previously unshipped 2026-09-08 acquire.py. No login bypass,
cookie export, entitlement parameters, or replacement-video fallback.
"""
import argparse,asyncio,datetime,json,os,pathlib,re,shutil,sys
from urllib.parse import urlparse
from playwright.async_api import async_playwright
from media_assets import fresh,probe,run,save


def canonical(url):
    u=urlparse(url)
    match=re.fullmatch(r'/video/(BV[A-Za-z0-9]{10})/?',u.path)
    if u.scheme!='https' or u.hostname not in {'www.bilibili.com','bilibili.com'} or not match or u.username or u.password or u.port not in (None,443):
        raise ValueError('Use an HTTPS bilibili.com/video/BV... page URL')
    return match.group(1)


def media_url(item):
    url=item.get('baseUrl') or item.get('base_url') or item.get('url')
    if not isinstance(url,str):raise ValueError('Missing playable stream URL')
    u=urlparse(url);host=u.hostname or ''
    if u.scheme!='https' or u.username or u.password or u.port not in (None,443) or not any(host==d or host.endswith('.'+d) for d in ['bilivideo.com','bilivideo.cn','akamaized.net']):
        raise ValueError('Unrecognized media host; preserve the page and inspect manually')
    return url


def choose_parts(info):
    if info.get('dash'):
        dash=info['dash'];videos=dash.get('video') or [];audios=dash.get('audio') or []
        if not videos or not audios:raise ValueError('Current page does not expose both video and audio')
        # Match the historical acquisition's lowest-bandwidth selection.
        v=min(videos,key=lambda x:x.get('bandwidth',0));a=min(audios,key=lambda x:x.get('bandwidth',0))
        return 'dash',[('video.m4s',media_url(v)),('audio.m4s',media_url(a))]
    items=info.get('durl') or []
    if not 1<=len(items)<=20:raise ValueError('No supported current-page media streams')
    return 'durl',[(f'part-{n:03d}.media',media_url(d)) for n,d in enumerate(items)]


async def acquire(args):
    bvid=canonical(args.url)
    if not shutil.which(args.ffmpeg) or not shutil.which(args.ffprobe):raise ValueError('ffmpeg and ffprobe must be installed')
    out=fresh(pathlib.Path(args.out))
    profile=pathlib.Path(args.profile_dir).expanduser() if args.profile_dir else pathlib.Path(os.environ.get('LOCALAPPDATA',str(pathlib.Path.home())))/'MemeAssetTools/browser-bilibili'
    profile.mkdir(parents=True,exist_ok=True)
    rec={'url':args.url,'bvid':bvid,'collected_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),
         'status':'pending','acquisition':'actual_page_playinfo_with_browser_session','access_scope':'current_page_playable_stream',
         'semantic_review':'pending','metadata':None}
    try:
        async with async_playwright() as p:
            context=await p.chromium.launch_persistent_context(str(profile),headless=not args.interactive,viewport={'width':1440,'height':1000},locale='zh-CN')
            try:
                page=context.pages[0] if context.pages else await context.new_page()
                playback_responses=[]
                page.on('response',lambda response: playback_responses.append(response) if urlparse(response.url).hostname=='api.bilibili.com' and urlparse(response.url).path.endswith('/playurl') else None)
                await page.goto(args.url,wait_until='domcontentloaded',timeout=35000)
                await page.wait_for_timeout(5500)
                if args.interactive:
                    print(json.dumps({'status':'waiting_for_manual_verification','hold_seconds':args.hold}),flush=True)
                    for _ in range(args.hold):
                        if (out/'continue').exists() or page.is_closed():break
                        await page.wait_for_timeout(1000)
                body=await page.locator('body').inner_text(timeout=8000)
                (out/'page.txt').write_text(body[:30000],encoding='utf8')
                await page.screenshot(path=str(out/'page.png'))
                if re.search('验证码中间页|安全验证|完成下方验证|访问被拒绝|请完成验证',(await page.title())+' '+body[:1500]):
                    rec['status']='manual_verification_required';return rec
                meta=await page.evaluate('()=>{const d=window.__INITIAL_STATE__?.videoData;return d?{bvid:d.bvid,cid:d.cid,title:d.title,owner:d.owner?.name,stat:d.stat,pubdate:d.pubdate,duration:d.duration}:null}')
                rec['metadata']=meta
                if not meta or meta.get('bvid')!=bvid:raise ValueError('Page metadata does not match the requested video')
                video=page.locator('video').first
                await video.wait_for(state='attached',timeout=15000)
                await video.evaluate('(v)=>{v.muted=true;return v.play().catch(()=>null)}')
                await page.wait_for_function('()=>{const v=document.querySelector("video");return v&&v.readyState>=2&&v.videoWidth>0}',timeout=15000)
                rec['player']=await video.evaluate('(v)=>({duration:v.duration,width:v.videoWidth,height:v.videoHeight})')
                info=await page.evaluate('()=>window.__playinfo__?.data')
                if not info:
                    for response in reversed(playback_responses):
                        try:
                            payload=await response.json()
                            candidate=payload.get('data') or payload.get('result') or {}
                            if candidate.get('dash') or candidate.get('durl'):
                                info=candidate;rec['playinfo_origin']='actual_player_network_response';break
                        except Exception:continue
                if not info:raise ValueError('Current playable page exposes no supported playinfo; do not change source silently')
                kind,parts=choose_parts(info);rec['stream_layout']=kind
                total=0
                for name,url in parts:
                    response=await context.request.get(url,headers={'Referer':args.url},timeout=60000)
                    if not response.ok:raise ValueError('Media HTTP '+str(response.status))
                    if int(response.headers.get('content-length','0'))+total>args.max_mb*1024*1024:raise ValueError('Media exceeds download size limit')
                    data=await response.body();total+=len(data)
                    if total>args.max_mb*1024*1024:raise ValueError('Media exceeds download size limit')
                    (out/name).write_bytes(data)
                target=out/'source.mp4'
                if kind=='dash':cmd=[args.ffmpeg,'-hide_banner','-loglevel','error','-nostdin','-n','-i',str(out/'video.m4s'),'-i',str(out/'audio.m4s'),'-map','0:v:0','-map','1:a:0','-c','copy',str(target)]
                elif len(parts)==1:cmd=[args.ffmpeg,'-hide_banner','-loglevel','error','-nostdin','-n','-i',str(out/parts[0][0]),'-c','copy',str(target)]
                else:
                    (out/'parts.txt').write_text(''.join("file '"+name+"'\n" for name,_ in parts),encoding='utf8')
                    cmd=[args.ffmpeg,'-hide_banner','-loglevel','error','-nostdin','-n','-f','concat','-safe','1','-i',str(out/'parts.txt'),'-c','copy',str(target)]
                run(cmd);media=probe(target,args.ffprobe)
                if media['video_stream'] is None or media['audio_stream'] is None:raise ValueError('Downloaded file lacks synchronized video or audio')
                run([args.ffmpeg,'-v','error','-nostdin','-i',str(target),'-f','null','-'],timeout=180)
                rec.update(status='acquired',media=media,bytes_downloaded=total)
            finally:await context.close()
    except Exception as e:
        rec.update(status='failed',error=str(e)[:500] if isinstance(e,ValueError) else type(e).__name__)
    finally:
        # Never persist signed CDN URLs, cookies, or a browser storage snapshot.
        save(out/'source.json',rec)
    return rec


def main():
    if hasattr(sys.stdout,'reconfigure'):sys.stdout.reconfigure(encoding='utf8',errors='replace')
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url',required=True);parser.add_argument('--out',required=True)
    parser.add_argument('--profile-dir');parser.add_argument('--interactive',action='store_true');parser.add_argument('--hold',type=int,default=300)
    parser.add_argument('--max-mb',type=int,default=256);parser.add_argument('--ffmpeg',default='ffmpeg');parser.add_argument('--ffprobe',default='ffprobe')
    args=parser.parse_args()
    if not 0<=args.hold<=1800 or not 1<=args.max_mb<=1024:parser.error('Invalid hold or size limit')
    try:result=asyncio.run(acquire(args))
    except Exception as e:result={'status':'failed','error':str(e) if isinstance(e,ValueError) else type(e).__name__}
    print(json.dumps(result,ensure_ascii=False,indent=2))
    return 0 if result['status']=='acquired' else 2


if __name__=='__main__':raise SystemExit(main())
