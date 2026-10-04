'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {patchSearchLimit, parseSearchJsonl} = require('./crawler-adapter.cjs');

for (const platform of ['douyin', 'kuaishou']) {
  test(platform + ' enforces one unique-video budget across pages and keywords', () => {
    const dy = platform === 'douyin';
    const size = dy ? 'dy_limit_count' : 'ks_limit_count';
    const item = dy ? 'aweme_info' : 'video_detail';
    const marker = dy ? 'aweme_list.append(aweme_info.get("aweme_id", ""))' : 'video_id_list.append(video_detail.get("photo", {}).get("id"))';
    const source = [
      'class C:',
      '    async def search(self):',
      '        ' + size + ' = ' + (dy ? '10' : '20'),
      '        if config.CRAWLER_MAX_NOTES_COUNT < ' + size + ':',
      '            config.CRAWLER_MAX_NOTES_COUNT = ' + size,
      '        start_page = config.START_PAGE',
      '        for keyword in config.KEYWORDS.split(","):',
      '            page = 1',
      '            aweme_list = []',
      '            video_id_list = []',
      '            while (page - start_page + 1) * ' + size + ' <= config.CRAWLER_MAX_NOTES_COUNT:',
      '                self.calls.append(keyword)',
      '                for ' + item + ' in self.rows(keyword, page):',
      '                    ' + marker,
      '                    self.saved.append(' + (dy ? 'aweme_info.get("aweme_id")' : 'video_detail.get("photo", {}).get("id")') + ')',
      '                page += 1',
    ].join('\n') + '\n';
    const patched = patchSearchLimit(source, platform);
    const runner = [
      'import asyncio',
      'from types import SimpleNamespace',
      patched,
      'def rows(keyword, page):',
      '    values = [keyword + str(page) + str(i) for i in range(30)]',
      '    values = [x for value in values for x in (value,value)]',
      '    return [' + (dy ? '{"aweme_id": x}' : '{"photo": {"id": x}}') + ' for x in values]',
      'for n in [1, 5, 10, 15, 20, 31, 100]:',
      '    config = SimpleNamespace(CRAWLER_MAX_NOTES_COUNT=n, START_PAGE=1, KEYWORDS="a,b,c")',
      '    c = C(); c.calls=[]; c.saved=[]; c.rows=rows',
      '    asyncio.run(c.search())',
      '    assert len(c.saved) == n, (n, len(c.saved))',
      '    assert len(set(c.saved)) == n',
      '    assert set(c.calls) == {"a"}, c.calls',
      '    assert config.CRAWLER_MAX_NOTES_COUNT == n',
      'config = SimpleNamespace(CRAWLER_MAX_NOTES_COUNT=5, START_PAGE=1, KEYWORDS="a,b,c")',
      'c = C(); c.calls=[]; c.saved=[]; c.rows=lambda keyword,page: rows(keyword, page)[:4]',
      'asyncio.run(c.search())',
      'assert len(c.saved) == 5 and len(set(c.saved)) == 5',
      'print("PASS")',
    ].join('\n');
    const result = spawnSync('python3', ['-c', runner], {encoding:'utf8', timeout:10000});
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /PASS/);
    assert.throws(() => patchSearchLimit('unsupported', platform), /不匹配/);
  });
}

test('JSONL cap applies across files after deduplication', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hot-topic-limit-'));
  try {
    for (const platform of ['douyin', 'kuaishou']) {
      const key = platform === 'douyin' ? 'aweme_id' : 'video_id';
      const data = Array.from({length:30}, (_,i)=>({[key]:String(Math.floor(i/2)),title:'校园'}));
      fs.writeFileSync(path.join(dir,'search_contents_one.jsonl'), data.map(JSON.stringify).join('\n'));
      fs.writeFileSync(path.join(dir,'search_contents_two.jsonl'), data.map(JSON.stringify).join('\n'));
      for (const max of [1,5,10,12]) {
        const rows = parseSearchJsonl(dir, platform, max);
        assert.equal(rows.length,max);
        assert.equal(new Set(rows.map(x=>x[key])).size,max);
      }
    }
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});
