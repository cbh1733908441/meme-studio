"""Native platform browsing in an isolated persistent Chromium profile.

Uses the installed Playwright library. Captchas are left to the user.
"""
import argparse, asyncio, base64, datetime, json, os, pathlib, re, urllib.parse
from playwright.async_api import async_playwright

def dump(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')

async def run(args):
    out=pathlib.Path(args.out).resolve();out.mkdir(parents=True,exist_ok=True)
    profile=pathlib.Path(os.environ.get('LOCALAPPDATA',str(pathlib.Path.home()))) / 'MemeAssetTools' / ('browser-'+args.platform)
    profile.mkdir(parents=True,exist_ok=True)
    if args.url:
        url=args.url
        host=urllib.parse.urlparse(url).hostname or ''
        allowed='bilibili.com' if args.platform=='bilibili' else 'douyin.com'
        if urllib.parse.urlparse(url).scheme!='https' or not(host==allowed or host.endswith('.'+allowed)):
            raise ValueError('URL must belong to the selected platform over HTTPS')
    else:
        query=urllib.parse.quote(args.query or '嘉豪')
        url=('https://search.bilibili.com/all?keyword='+query if args.platform=='bilibili' else 'https://www.douyin.com/search/'+query+'?type=video')
    async with async_playwright() as p:
        context=await p.chromium.launch_persistent_context(str(profile),headless=not args.interactive,viewport={'width':1440,'height':1000},locale='zh-CN')
        page=context.pages[0] if context.pages else await context.new_page()
        result={'url':url,'platform':args.platform,'channel':'native_browser','profile':'isolated_persistent','interactive':args.interactive,'collected_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'sort_requested':args.sort}
        try:
            await page.goto(url,wait_until='domcontentloaded',timeout=35000)
            await page.wait_for_timeout(6000)
            if not args.url and args.platform=='bilibili' and args.sort=='plays':
                await page.get_by_text('最多播放',exact=True).click(timeout=10000)
                await page.wait_for_timeout(4000)
                result['sort_applied']='plays'
            if args.interactive:
                print(json.dumps({'status':'waiting_for_manual_verification','seconds':args.hold,'platform':args.platform},ensure_ascii=False),flush=True)
                # Keep this browser open for manual authentication, without solving challenges.
                deadline=asyncio.get_running_loop().time()+args.hold
                while asyncio.get_running_loop().time()<deadline and not page.is_closed():
                    await page.wait_for_timeout(1000)
                    if (out/'continue').exists(): break
            result['title']=await page.title();result['final_url']=page.url
            body=await page.locator('body').inner_text(timeout=6000)
            (out/'page.txt').write_text(body[:30000],encoding='utf-8')
            await page.screenshot(path=str(out/'page.png'))
            blocked=bool(re.search('验证码中间页|安全验证|完成下方验证|访问被拒绝|请完成验证',result['title']+' '+body[:1500]))
            links=await page.locator('a[href]').evaluate_all('els => els.map(e=>({title:(e.getAttribute("title")||e.querySelector("h3")?.innerText||e.innerText).trim(),url:e.href,named:Boolean(e.getAttribute("title")||e.querySelector("h3"))})).filter(e=>e.url.includes("/video/"))')
            unique={}
            for link in links:
                old=unique.get(link['url'])
                if not old or (link['named'] and not old['named']) or (link['named']==old['named'] and len(link['title'])>len(old['title'])): unique[link['url']]=link
            result['candidates']=list(unique.values())[:60]
            if args.platform=='bilibili':
                result['search_cards']=await page.locator('.bili-video-card').evaluate_all('els=>els.map(e=>({text:e.innerText,url:e.querySelector("a[href*=\\"/video/\\"]")?.href})).filter(e=>e.url)')
            result['status']='manual_verification_required' if blocked else ('results_found' if unique else 'page_opened')
            if args.url and not blocked:
                if args.platform=='bilibili':
                    result['video_metadata']=await page.evaluate('''()=>{
                      const d=window.__INITIAL_STATE__?.videoData;
                      return d?{bvid:d.bvid,title:d.title,owner:d.owner?.name,pubdate:d.pubdate,stat:d.stat}:null;
                    }''')
                video=page.locator('video').first
                try:
                    await video.wait_for(state='attached',timeout=15000)
                    await video.evaluate('(v)=>{v.muted=true;return v.play().catch(()=>null)}')
                    await page.wait_for_function('()=>{let v=document.querySelector("video");return v && v.readyState>=2 && v.videoWidth>0}',timeout=15000)
                    result['video']=await video.evaluate('(v)=>({duration:v.duration,width:v.videoWidth,height:v.videoHeight,readyState:v.readyState,paused:v.paused,currentTime:v.currentTime})')
                    frames=[]
                    for t in args.times:
                        await video.evaluate('(v,t)=>{v.pause();v.currentTime=t}',t)
                        await page.wait_for_function('(t)=>{const v=document.querySelector("video");return v && !v.seeking && v.readyState>=2 && Math.abs(v.currentTime-t)<0.25}',arg=t,timeout=15000)
                        await video.evaluate('()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
                        file='video-'+str(t).replace('.','_')+'.png'
                        await video.screenshot(path=str(out/file))
                        frames.append({'requested_s':t,'actual_s':await video.evaluate('(v)=>v.currentTime'),'file':file})
                    result['frames']=frames;result['status']='video_frames_captured'
                    if args.record_seconds:
                        capture=await video.evaluate('''async (v,opts)=>{
                          v.currentTime=opts.start;v.muted=true;
                          await new Promise(r=>{if(!v.seeking)r();else v.addEventListener('seeked',r,{once:true})});
                          await v.play();
                          const stream=v.captureStream();const tracks=stream.getAudioTracks();
                          if(!tracks.length){v.pause();return {error:'no_audio_track'}};
                          const audio=new MediaStream(tracks);
                          const recorder=new MediaRecorder(audio,{mimeType:'audio/webm;codecs=opus'});
                          const chunks=[];const started=v.currentTime;
                          return await new Promise((resolve,reject)=>{
                            recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data)};
                            recorder.onerror=e=>reject(new Error('capture_failed'));
                            recorder.onstop=async()=>{
                              const end=v.currentTime;v.pause();
                              const blob=new Blob(chunks,{type:'audio/webm'});
                              const data=await new Promise(r=>{const f=new FileReader();f.onload=()=>r(f.result.split(',')[1]);f.readAsDataURL(blob)});
                              resolve({data,mime:'audio/webm',actual_start:started,actual_end:end});
                            };
                            recorder.start();setTimeout(()=>{if(recorder.state!=='inactive')recorder.stop()},opts.seconds*1000);
                          });
                        }''',{'start':args.start,'seconds':args.record_seconds})
                        if capture.get('data'):
                            raw=base64.b64decode(capture.pop('data'));(out/'browser-audio.webm').write_bytes(raw)
                            capture.update(file='browser-audio.webm',bytes=len(raw),semantic_review='pending')
                        result['audio_capture']=capture
                except Exception as e: result['video_error']=type(e).__name__
        except Exception as e:
            result['status']='browser_error';result['error']=type(e).__name__
        finally:
            dump(out/'result.json',result)
            await context.close()
        print(json.dumps(result,ensure_ascii=False),flush=True)
        return 2 if result['status'] in ('manual_verification_required','browser_error') else 0

if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--platform',choices=['douyin','bilibili'],required=True)
    group=parser.add_mutually_exclusive_group();group.add_argument('--query');group.add_argument('--url')
    parser.add_argument('--out',required=True)
    parser.add_argument('--interactive',action='store_true',help='Open a visible browser for user login/captcha; never solve it automatically')
    parser.add_argument('--hold',type=int,default=300)
    parser.add_argument('--times',type=float,nargs='*',default=[0,2,4])
    parser.add_argument('--record-seconds',type=float,default=0,help='Capture the actual player audio for up to 60 seconds; this does not interpret it')
    parser.add_argument('--start',type=float,default=0)
    parser.add_argument('--sort',choices=['plays','relevance'],default='plays',help='Bilibili search uses the native Most viewed control; likes are verified on video pages')
    args=parser.parse_args()
    if not 0<=args.hold<=1800 or not 0<=args.record_seconds<=60 or args.start<0 or any(t<0 for t in args.times): parser.error('Invalid hold duration or timestamps')
    raise SystemExit(asyncio.run(run(args)))
