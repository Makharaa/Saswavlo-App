const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const importer=fs.readFileSync(path.join(root,'src/lib/route-import-catalog.ts'),'utf8');
const recordingRoot=path.join(root,'data/private/audio/recorded');
const manifest=require('../data/private/audio/recorded/manifest.json');
test('the release contains only the four permitted Gori imports and original voice files',()=>{
 const files=fs.readdirSync(path.join(root,'data/imports'));
 assert.deepEqual(files.filter(x=>x.endsWith('.json')&&!x.endsWith('-review.json')&&x!=='catalog.json').sort(),
  [1,2,3,4].map(n=>`simulatori-gori-route-${n}.json`));
 assert.deepEqual(fs.readdirSync(recordingRoot).filter(x=>x.endsWith('.mp3')).sort(),
  Object.values(manifest.phrases).sort());
 assert.equal(Object.values(manifest.phrases).length,13);
 assert.equal(importer.includes('"gori-route-1"'),false);
 const routes=require('../data/imports/catalog.json');
 assert.equal(routes.length,4);
 assert.ok(routes.every(x=>/^simulatori-gori-route-[1-4]$/.test(x.source)));
});
test('cleanup command runs dry-run by default and requires a backup file to apply',()=>{
 const script=fs.readFileSync(path.join(root,'scripts/remove-legacy-gori-routes.cjs'),'utf8');
 assert.ok(script.includes("const apply = process.argv.includes('--apply')"));
 assert.ok(script.includes('fs.statSync(backupPath).size < 1024'));
 assert.ok(script.includes("v.snapshot->>'importSource' = ANY"));
 assert.ok(script.includes("verified.rows[0].count !== 4"));
});
