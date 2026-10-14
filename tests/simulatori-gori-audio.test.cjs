"use strict";
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const audioRoot=path.join(__dirname,'../data/private/audio/recorded');
const manifest=require('../data/private/audio/recorded/manifest.json');
const pack=Object.entries(manifest.phrases).filter(([key])=>key.startsWith('simulatori-gori/'));
test('Gori original recording pack includes all 13 playable MP3 assets',()=>{
 assert.equal(pack.length,13);
 for(const [key,file] of pack){
  assert.equal(path.basename(file),file);
  assert.match(file,/^simulatori-gori-[a-z0-9-]+\.mp3$/);
  const data=fs.readFileSync(path.join(audioRoot,file));
  assert.ok(data.length>1000,`Empty audio: ${file}`);
  assert.ok(data.subarray(0,3).toString()==='ID3'||data[0]===0xff,`Not MP3: ${file}`);
 }
});
for(let n=1;n<=4;n++){
 test(`Gori N${n} has a recorded original audio file for every checkpoint`,()=>{
  const route=require(`../data/imports/simulatori-gori-route-${n}.json`);
  for(const checkpoint of route.checkpoints){
   assert.ok(checkpoint.voice.startsWith('simulatori-gori/'));
   assert.ok(manifest.phrases[checkpoint.voice],checkpoint.voice);
   assert.ok(fs.statSync(path.join(audioRoot,manifest.phrases[checkpoint.voice])).size>1000);
  }
 });
}
