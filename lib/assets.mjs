import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
const types = {
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};
export function registerAssets(analysis, dir, jobId, revision) {
  const assets = [];
  for (const b of analysis.branches)
    for (const m of b.media) {
      try {
        const file = fs.realpathSync(path.resolve(dir, m.path)),
          root = fs.realpathSync(dir);
        const type = types[path.extname(file).toLowerCase()];
        if (
          !file.startsWith(root + path.sep) ||
          file.includes(path.sep + ".agents" + path.sep) ||
          !type ||
          !fs.statSync(file).isFile()
        )
          throw Error();
        if (m.start_s !== null && m.end_s !== null && m.end_s < m.start_s)
          throw Error();
        const relativePath = path.relative(root, file);
        const id =
          "asset-" +
          createHash("sha256")
            .update(jobId + ":" + relativePath)
            .digest("hex")
            .slice(0, 20);
        const existing = assets.find((a) => a.id === id);
        if (existing) {
          existing.branchIds.push(b.id);
          continue;
        }
        assets.push({
          id,
          revision,
          branchIds: [b.id],
          stage: "analysis",
          jobId,
          relativePath,
          mediaType: type,
          sourceUrl: m.source_url,
          start_s: m.start_s,
          end_s: m.end_s,
          caption: m.caption,
        });
      } catch {
        b.gaps.push("素材文件待补或无法读取：" + m.path);
      }
    }
  return assets;
}
