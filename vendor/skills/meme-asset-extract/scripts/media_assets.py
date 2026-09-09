#!/usr/bin/env python3
"""Deterministic media extraction; semantic selection is supplied by the caller."""
import argparse
import hashlib
import importlib.util
import json
import math
import re
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

STILLS = {'.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tif', '.tiff'}
ROLES = {'original', 'remix', 'repost', 'explainer', 'unknown'}


def run(argv, timeout=180):
    result = subprocess.run(argv, capture_output=True, text=True, encoding='utf-8',
                            errors='replace', timeout=timeout, shell=False)
    if result.returncode:
        raise ValueError(result.stderr.strip()[-1200:] or 'media command failed')
    return result.stdout


def save(path, obj):
    path.write_text(json.dumps(obj, ensure_ascii=False, indent=2), encoding='utf-8')


def fresh(path):
    path = path.resolve()
    if path.exists() and (not path.is_dir() or any(path.iterdir())):
        raise ValueError('output directory must be new or empty')
    path.mkdir(parents=True, exist_ok=True)
    return path


def number(value, label):
    if isinstance(value, bool) or not isinstance(value, (float, int)) or not math.isfinite(value):
        raise ValueError(label + ' must be a finite number')
    return float(value)


def identifier(value):
    if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,80}', value):
        raise ValueError('invalid id')
    return value


def probe(path, executable):
    path = Path(path).resolve()
    if not path.is_file():
        raise ValueError('source file does not exist: ' + str(path))
    data = json.loads(run([executable, '-v', 'error', '-show_streams', '-show_format',
                           '-of', 'json', str(path)]))
    streams = data.get('streams', [])
    video = next((s for s in streams if s.get('codec_type') == 'video'
                  and not s.get('disposition', {}).get('attached_pic')), None)
    audio = next((s for s in streams if s.get('codec_type') == 'audio'), None)
    duration = data.get('format', {}).get('duration')
    if duration is None:
        durations = [float(s['duration']) for s in streams if s.get('duration')]
        duration = max(durations) if durations else None
    duration = float(duration) if duration is not None else None
    if duration is not None and (not math.isfinite(duration) or duration <= 0):
        duration = None
    # WEBP may be animated; callers must not silently treat it as a movie.
    kind = 'image' if path.suffix.lower() in STILLS else 'video' if video else 'audio' if audio else 'unknown'
    digest = hashlib.sha256()
    with path.open('rb') as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b''):
            digest.update(chunk)
    return {'path': path.as_posix(), 'kind': kind, 'duration_s': duration,
            'width': video.get('width') if video else None,
            'height': video.get('height') if video else None,
            'video_stream': video.get('index') if video else None,
            'audio_stream': audio.get('index') if audio else None,
            'sha256': digest.hexdigest(), 'bytes': path.stat().st_size}


def point(value, info):
    value = number(value, 'time')
    if value < 0 or (info['kind'] == 'image' and value != 0):
        raise ValueError('invalid image time')
    if info['kind'] != 'image' and (info['duration_s'] is None or value >= info['duration_s']):
        raise ValueError('time outside known source duration')
    return value


def interval(item, info):
    start = number(item.get('start'), 'start')
    end = number(item.get('end'), 'end')
    if info['kind'] == 'image' or info['duration_s'] is None:
        raise ValueError('clip needs a temporal source with known duration')
    if start < 0 or end <= start or end > info['duration_s'] + 0.001:
        raise ValueError('clip outside source duration')
    return start, end


def visual_filter(item, info, video=False):
    filters = []
    crop = item.get('crop')
    if crop is not None:
        if not isinstance(crop, list) or len(crop) != 4:
            raise ValueError('crop must be [x,y,width,height]')
        x, y, w, h = [number(v, 'crop') for v in crop]
        if min(x, y) < 0 or min(w, h) <= 0 or x + w > 1.000001 or y + h > 1.000001:
            raise ValueError('crop outside image')
        iw, ih = info['width'], info['height']
        cw, ch = int(w * iw), int(h * ih)
        if cw < 2 or ch < 2:
            raise ValueError('crop too small')
        filters.append(f'crop={cw}:{ch}:{int(x*iw)}:{int(y*ih)}')
    if item['type'] == 'gif' or video:
        width = item.get('width', 480)
        if isinstance(width, bool) or not isinstance(width, int) or not 16 <= width <= 1920:
            raise ValueError('width must be an integer from 16 to 1920')
        filters.append(f"scale=w='trunc(min({width},iw)/2)*2':h=-2")
    return ','.join(filters)


def encode(item, info, target, ffmpeg, as_video=False):
    kind = 'video' if as_video else item['type']
    if kind != 'audio' and info['video_stream'] is None:
        raise ValueError('source has no visual stream')
    if kind == 'audio' and info['audio_stream'] is None:
        raise ValueError('source has no audio stream')
    cmd = [ffmpeg, '-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-noautorotate', '-i', info['path']]
    expected = None
    if kind == 'image':
        cmd += ['-ss', str(point(item.get('at', 0), info)), '-frames:v', '1']
    else:
        start, end = interval(item, info)
        expected = end - start
        cmd += ['-ss', str(start), '-t', str(expected)]
    if kind == 'audio':
        cmd += ['-map', f"0:{info['audio_stream']}", '-vn', '-c:a', 'pcm_s16le']
    else:
        cmd += ['-map', f"0:{info['video_stream']}"]
        vf = visual_filter(item, info, video=kind == 'video')
        if kind == 'gif':
            fps = number(item.get('fps', 12), 'fps')
            if not 1 <= fps <= 30:
                raise ValueError('gif fps must be from 1 to 30')
            if not isinstance(item.get('loop', False), bool):
                raise ValueError('loop must be a boolean')
            prefix = (vf + ',') if vf else ''
            cmd += ['-vf', prefix + f'fps={fps},split[a][b];[a]palettegen[p];[b][p]paletteuse',
                    '-an', '-loop', '0' if item.get('loop') else '-1']
        else:
            if vf:
                cmd += ['-vf', vf]
            if kind == 'video':
                if info['audio_stream'] is not None:
                    cmd += ['-map', f"0:{info['audio_stream']}", '-c:a', 'aac']
                cmd += ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart']
            else:
                cmd += ['-an', '-update', '1']
    run(cmd + [str(target)])
    return expected


def check_output(path, expected, args, require_audio=False):
    info = probe(path, args.ffprobe)
    run([args.ffmpeg, '-hide_banner', '-v', 'error', '-nostdin', '-i', str(path), '-f', 'null', '-'])
    if expected is not None:
        if info['duration_s'] is None or abs(info['duration_s'] - expected) > max(0.25, expected * .03):
            raise ValueError('export duration differs from requested interval')
    if require_audio and info['audio_stream'] is None:
        raise ValueError('export lost audio')
    return info


def render(args):
    plan_path = Path(args.plan).resolve()
    plan = json.loads(plan_path.read_text(encoding='utf-8-sig'))
    sources = {}
    for source in plan['sources']:
        sid = identifier(source['id'])
        if sid in sources or source.get('role', 'unknown') not in ROLES:
            raise ValueError('duplicate source id or invalid role')
        path = Path(source['path'])
        info = probe(path if path.is_absolute() else plan_path.parent / path, args.ffprobe)
        sources[sid] = {**source, **info, 'role': source.get('role', 'unknown')}
    if not sources:
        raise ValueError('at least one source is required')
    features = plan.get('features', [])
    feature_ids = set()
    for feature in features:
        fid = identifier(feature['id'])
        if fid in feature_ids:
            raise ValueError('duplicate feature id')
        feature_ids.add(fid)
        state = feature.get('evidence_status')
        if state not in {'observed', 'source_reported', 'hypothesis'}:
            raise ValueError('invalid evidence status')
        evidence = feature.get('evidence', [])
        if state in {'observed', 'source_reported'} and not evidence:
            raise ValueError('observations and reports need evidence')
        for evidence_item in evidence:
            sid = evidence_item.get('source_id')
            if sid:
                if sid not in sources:
                    raise ValueError('unknown evidence source')
                if 'end' in evidence_item:
                    interval(evidence_item, sources[sid])
                else:
                    point(evidence_item.get('at', evidence_item.get('start', 0)), sources[sid])
            elif state == 'observed' or not evidence_item.get('url'):
                raise ValueError('observed evidence needs a local source')
    ids = set()
    for item in plan['assets']:
        aid = identifier(item['id'])
        if aid in ids or item.get('type') not in {'image', 'audio', 'gif', 'video'}:
            raise ValueError('duplicate asset id or invalid type')
        ids.add(aid)
        if item.get('source_id') not in sources:
            raise ValueError('unknown asset source')
        if not isinstance(item.get('reason'), str) or not item['reason'].strip():
            raise ValueError('asset needs a selection reason')
        if not set(item.get('feature_ids', [])).issubset(feature_ids):
            raise ValueError('unknown feature reference')
    out = fresh(Path(args.out))
    results, failures = [], []
    for item in plan['assets']:
        info = sources[item['source_id']]
        record = {**item, 'files': [], 'technical_status': 'pending', 'semantic_review': 'pending'}
        kinds = [(item['type'], False)]
        if item['type'] == 'gif' and item.get('with_video'):
            kinds.append(('video', True))
        for kind, as_video in kinds:
            target = out / (item['id'] + {'image': '.png', 'audio': '.wav', 'gif': '.gif', 'video': '.mp4'}[kind])
            try:
                expected = encode(item, info, target, args.ffmpeg, as_video=as_video)
                exported = check_output(target, expected, args,
                    require_audio=kind == 'audio' or (kind == 'video' and info['audio_stream'] is not None))
                record['files'].append({'type': kind, **exported, 'technical_status': 'passed'})
            except (ValueError, subprocess.TimeoutExpired) as error:
                failures.append({'asset_id': item['id'], 'type': kind, 'reason': str(error)})
                record['files'].append({'type': kind, 'path': target.as_posix() if target.exists() else None,
                                        'technical_status': 'failed', 'error': str(error)})
        record['technical_status'] = 'passed' if all(x['technical_status'] == 'passed' for x in record['files']) else 'failed'
        results.append(record)
    manifest = {'version': 1, 'meme': plan.get('meme'), 'branch': plan.get('branch'),
                'created_at': datetime.now(timezone.utc).isoformat(),
                'status': 'partial' if failures else 'extracted_pending_semantic_review',
                'sources': list(sources.values()), 'features': features, 'assets': results,
                'missing': plan.get('missing', []) + failures}
    save(out / 'manifest.json', manifest)
    lines = ['# Meme 素材包', '', str(plan.get('meme', '')) + ' · ' + str(plan.get('branch', '')),
             '', '技术导出与语义检查分别记录。新导出内容的语义检查默认为待确认。', '', '| 素材 | 文件 | 选择理由 | 技术状态 |', '|---|---|---|---|']
    for record in results:
        links = ' · '.join('[' + f['type'] + '](<' + f['path'] + '>)' for f in record['files']
                           if f.get('path') and f['technical_status'] == 'passed')
        reason = record['reason'].replace('|', '\\|').replace('\n', ' ')
        lines.append(f"|{record['id']}|{links or '未取得'}|{reason}|{record['technical_status']}|")
    lines += ['', '## 特征', '']
    for feature in features:
        lines.append('- ' + feature.get('text', '') + ' [' + feature['evidence_status'] + ']')
    if manifest['missing']:
        lines += ['', '## 缺口', ''] + ['- ' + (x if isinstance(x, str) else json.dumps(x, ensure_ascii=False)) for x in manifest['missing']]
    lines += ['', '[完整来源、时间与检查状态](<' + (out / 'manifest.json').as_posix() + '>)']
    (out / 'index.md').write_text('\n'.join(lines), encoding='utf-8')
    return {'status': manifest['status'], 'manifest': (out / 'manifest.json').as_posix(),
            'index': (out / 'index.md').as_posix(), 'failed_exports': len(failures)}, 2 if failures else 0


def preview(args):
    info = probe(args.source, args.ffprobe)
    if info['video_stream'] is None:
        return {'status': 'no_visual_stream', 'source': info}, 0
    if not 1 <= args.count <= 48:
        raise ValueError('count must be from 1 to 48')
    if info['kind'] == 'image':
        times = [0]
    else:
        start, end = interval({'start': args.start, 'end': args.end if args.end is not None else info['duration_s']}, info)
        times = [start + (end - start) * i / args.count for i in range(args.count)]
    out = fresh(Path(args.out))
    frames = []
    for i, at in enumerate(times):
        target = out / f'frame-{i+1:02d}.png'
        encode({'type': 'image', 'at': at}, info, target, args.ffmpeg)
        check_output(target, None, args)
        frames.append({'at': at, 'path': target.as_posix()})
    result = {'source': info, 'frames': frames, 'semantic_review': 'pending'}
    save(out / 'preview.json', result)
    return result, 0


def fetch(args):
    if urlparse(args.url).scheme not in {'http', 'https'}:
        raise ValueError('fetch requires an http(s) URL')
    executable = shutil.which('yt-dlp')
    if executable:
        cmd = [executable]
    elif importlib.util.find_spec('yt_dlp'):
        cmd = [sys.executable, '-m', 'yt_dlp']
    else:
        raise ValueError('yt-dlp unavailable; use a local file or available media acquisition tool')
    out = fresh(Path(args.out))
    cmd += ['--ignore-config', '--no-playlist', '--no-progress', '--quiet', '--no-overwrites',
            '--socket-timeout', '20', '--retries', '0', '--extractor-retries', '0',
            '--ffmpeg-location', str(Path(shutil.which(args.ffmpeg) or args.ffmpeg).resolve().parent),
            '-f', 'bv*[height<=720]+ba/b', '--merge-output-format', 'mp4',
            '-o', str(out / 'source.%(ext)s')]
    if shutil.which('node'):
        cmd += ['--js-runtimes', 'node']
    try:
        # Do not echo provider errors containing temporary signed media URLs.
        run(cmd + ['--', args.url], timeout=300)
        media = [p for p in out.glob('source.*') if p.suffix not in {'.part', '.ytdl', '.json'}]
        if len(media) != 1:
            raise ValueError('no single completed media file')
        result = {'status': 'downloaded', 'url': args.url, 'role': 'unknown', **probe(media[0], args.ffprobe)}
    except (ValueError, subprocess.TimeoutExpired):
        result = {'status': 'fetch_failed', 'url': args.url,
                  'reason': '未取得可验证媒体；来源可能不可访问、需要平台会话或下载器支持。保留来源并尝试其他已授权获取方式。'}
    save(out / 'source.json', result)
    return result, 0 if result['status'] == 'downloaded' else 2


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--ffmpeg', default='ffmpeg')
    parser.add_argument('--ffprobe', default='ffprobe')
    sub = parser.add_subparsers(dest='command', required=True)
    p = sub.add_parser('inspect'); p.add_argument('--source', required=True)
    p = sub.add_parser('preview'); p.add_argument('--source', required=True); p.add_argument('--out', required=True)
    p.add_argument('--count', type=int, default=8); p.add_argument('--start', type=float, default=0)
    p.add_argument('--end', type=float)
    p = sub.add_parser('fetch'); p.add_argument('--url', required=True); p.add_argument('--out', required=True)
    p = sub.add_parser('render'); p.add_argument('--plan', required=True); p.add_argument('--out', required=True)
    args = parser.parse_args()
    try:
        if args.command == 'inspect':
            result, code = probe(args.source, args.ffprobe), 0
        else:
            result, code = {'preview': preview, 'fetch': fetch, 'render': render}[args.command](args)
    except (OSError, ValueError, KeyError, TypeError, subprocess.TimeoutExpired) as error:
        result, code = {'status': 'error', 'error': str(error)}, 2
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return code


if __name__ == '__main__':
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    sys.exit(main())
