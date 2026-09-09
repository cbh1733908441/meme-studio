import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {ROOT} from '../server.mjs';
import {SKILL_VERSION, skillText} from '../lib/prompts.mjs';
test('runtime skill snapshot matches its versioned manifest and all prompt references exist', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT,'vendor/manifest.json'),'utf8'));
  assert.equal(manifest.version, SKILL_VERSION);
  for (const entry of manifest.files) {
    const data = fs.readFileSync(path.join(ROOT,'vendor/skills',entry.path));
    assert.equal(createHash('sha256').update(data).digest('hex'), entry.sha256, entry.path);
  }
  assert.ok(skillText(path.join(ROOT,'vendor/skills')).length > 0);
});
