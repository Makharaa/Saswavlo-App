"use strict";
// Converts an authorized user-provided Simulatori route export into four
// independent, unpublished DriveExam drafts. Never copies owner/account data.
const fs = require('node:fs');
const path = require('node:path');
const sourceFile = process.argv[2];
if (!sourceFile) throw Error('Usage: node scripts/prepare-simulatori-gori.cjs SOURCE.json');
const root = path.join(__dirname, '..');
const voice = {
  "simple-turns/turn-left-soon": [
    "simulatori-gori/turn-left-soon",
    "left"
  ],
  "simple-turns/turn-right-soon": [
    "simulatori-gori/turn-right-soon",
    "right"
  ],
  "simple-turns/turn-left-300m": [
    "simulatori-gori/turn-left-300m",
    "left"
  ],
  "simple-turns/turn-right-300m": [
    "simulatori-gori/turn-right-300m",
    "right"
  ],
  "simple-turns/turn-right-500m": [
    "simulatori-gori/turn-right-500m",
    "right"
  ],
  "simple-turns/turn-left-500m": [
    "simulatori-gori/turn-left-500m",
    "left"
  ],
  "move-straight/straight": [
    "simulatori-gori/straight",
    "straight"
  ],
  "move-straight/straight-soon": [
    "simulatori-gori/straight-soon",
    "straight"
  ],
  "move-straight/straight-300m": [
    "simulatori-gori/straight-300m",
    "straight"
  ],
  "roundabouts/roundabout-straight-300m": [
    "simulatori-gori/roundabout-straight-300m",
    "straight"
  ],
  "roundabouts/roundabout-straight-500m": [
    "simulatori-gori/roundabout-straight-500m",
    "straight"
  ]
};
const voiceTitles = {
  "simple-turns/turn-left-soon": "მალე გთხოვთ მოუხვიოთ მარცხნივ",
  "simple-turns/turn-right-soon": "მალე გთხოვთ მოუხვიოთ მარჯვნივ",
  "simple-turns/turn-left-300m": "300 მეტრში მოუხვიეთ მარცხნივ",
  "simple-turns/turn-right-300m": "300 მეტრში მოუხვიეთ მარჯვნივ",
  "simple-turns/turn-right-500m": "500 მეტრში მოუხვიეთ მარჯვნივ",
  "simple-turns/turn-left-500m": "500 მეტრში მოუხვიეთ მარცხნივ",
  "move-straight/straight": "შემდეგ მინიშნებამდე იმოძრავეთ პირდაპირ",
  "move-straight/straight-soon": "მალე იმოძრავეთ პირდაპირ",
  "move-straight/straight-300m": "300 მეტრში იმოძრავეთ პირდაპირ",
  "roundabouts/roundabout-straight-300m": "300 მეტრში წრიულზე იმოძრავეთ პირდაპირ",
  "roundabouts/roundabout-straight-500m": "500 მეტრში წრიულზე იმოძრავეთ პირდაპირ"
};
const voiceFiles = {
  "simple-turns/turn-left-soon": "simulatori-gori-turn-left-soon.mp3",
  "simple-turns/turn-right-soon": "simulatori-gori-turn-right-soon.mp3",
  "simple-turns/turn-left-300m": "simulatori-gori-turn-left-300m.mp3",
  "simple-turns/turn-right-300m": "simulatori-gori-turn-right-300m.mp3",
  "simple-turns/turn-right-500m": "simulatori-gori-turn-right-500m.mp3",
  "simple-turns/turn-left-500m": "simulatori-gori-turn-left-500m.mp3",
  "move-straight/straight": "simulatori-gori-straight.mp3",
  "move-straight/straight-soon": "simulatori-gori-straight-soon.mp3",
  "move-straight/straight-300m": "simulatori-gori-straight-300m.mp3",
  "roundabouts/roundabout-straight-300m": "simulatori-gori-roundabout-straight-300m.mp3",
  "roundabouts/roundabout-straight-500m": "simulatori-gori-roundabout-straight-500m.mp3"
};
const R = Math.PI / 180;
function haversine(a,b) {
  const dLat = (a.lat-b.lat)*R, dLng=(a.lng-b.lng)*R;
  const x=Math.sin(dLat/2)**2+Math.cos(a.lat*R)*Math.cos(b.lat*R)*Math.sin(dLng/2)**2;
  return 2*6371008.8*Math.asin(Math.min(1,Math.sqrt(x)));
}
function convert(raw, n) {
  if (!Array.isArray(raw.points) || raw.points.length<2 || !Array.isArray(raw.events)) throw Error('Bad route');
  const original = raw.points.map(p => [p.lng,p.lat]);
  if (original.some(([lng,lat])=>!Number.isFinite(lng)||!Number.isFinite(lat)||lng<43||lng>46||lat<40||lat>44)) throw Error('Bad coordinates');
  const cum=[0];for(let i=1;i<original.length;i++)cum.push(cum.at(-1)+haversine(raw.points[i-1],raw.points[i]));
  if(Math.abs(cum.at(-1)-raw.distanceMeters)>10) throw Error('Route length mismatch');
  const events=raw.events.filter(e=>e.kind&&!e.kind.startsWith('system/'))
    .map((e,index)=>({...e,_originalOrder:index}))
    .sort((a,b)=>a.distanceAlongRoute-b.distanceAlongRoute || a._originalOrder-b._originalOrder);
  if (events.some(e=>!(e.kind in voice)||!Number.isFinite(e.distanceAlongRoute)||e.distanceAlongRoute<0||e.distanceAlongRoute>cum.at(-1)+15)) throw Error('Unsupported event kind or distance');
  const points=[];const anchors=new Array(events.length); let at=0;
  for(let i=0;i<original.length-1;i++){
    points.push([...original[i]]);
    const lo=cum[i],hi=cum[i+1];
    while(at<events.length&&events[at].distanceAlongRoute<=hi+1e-8){
      let t= hi===lo?0:Math.max(0,Math.min(1,(events[at].distanceAlongRoute-lo)/(hi-lo)));
      if(events[at].distanceAlongRoute < lo-1e-8) throw Error('Nonmonotonic event placement');
      const anchor=[original[i][0]+(original[i+1][0]-original[i][0])*t,original[i][1]+(original[i+1][1]-original[i][1])*t];
      if(t<=1e-9) anchors[at]=points.length-1;
      else if(t>=1-1e-9) anchors[at]=points.length;
      else {
        const last=points.at(-1);
        if(last&&haversine({lng:last[0],lat:last[1]},{lng:anchor[0],lat:anchor[1]})<0.05) anchors[at]=points.length-1;
        else { points.push(anchor);anchors[at]=points.length-1; }
      }
      at++;
    }
  }
  points.push([...original.at(-1)]);
  if(at!==events.length) throw Error('Events outside route');
  const missing=[]; let maxAnchorOffset=0;
  const checkpoints=events.map((e,i)=>{
    const v=voice[e.kind],anchor=points[anchors[i]];
    const offset=haversine(e,{lng:anchor[0],lat:anchor[1]});maxAnchorOffset=Math.max(maxAnchorOffset,offset);
    if(offset>12) throw Error(`Uncertain event placement #${i+1}: ${Math.round(offset)}m`);
    if(!fs.existsSync(path.join(root, "data/private/audio/recorded", voiceFiles[e.kind]))) missing.push({orderIndex:i,kind:e.kind,phrase:voiceTitles[e.kind]});
    return {orderIndex:i,lng:e.lng,lat:e.lat,routeCoordinateIndex:anchors[i],type:v[1],title:voiceTitles[e.kind],voice:v[0],
      ttsVoice:'ka-GE-GiorgiNeural',speedLimit:null,triggerMeters:30,evaluation:{instructionOnly:true}};
  });
  const output={name:`Simulatori.ge - Gori N${n} (B/BE)`,city:'გორი',
    description:`Authorized Gori source route N${n}; ordered speech events anchored by distanceAlongRoute. Draft: verify in vehicle before publication.`,
    isPublished:false,fieldTestedAt:null,waypoints:points,waypointCoordinateIndices:points.map((_,i)=>i),
    coordinates:points,speedZones:[],checkpoints};
  return {output,report:{name:output.name,originalPointCount:raw.points.length,pointCount:points.length,
    eventCount:raw.events.length,voiceCheckpointCount:events.length,omittedSystemCount:raw.events.length-events.length,
    distanceMeters:raw.distanceMeters,maxAnchorOffsetMeters:maxAnchorOffset,missingAudio:missing}};
}
const all=JSON.parse(fs.readFileSync(sourceFile,'utf8'));
if(!Array.isArray(all))throw Error('Expected array');
const gori=all.filter(r=>r.city==='გორი (Gori)');
if(gori.length!==4)throw Error('Expected four Gori routes, found '+gori.length);
for(let n=1;n<=4;n++){
  const r=gori.find(x=>new RegExp(`N${n}(?![0-9])`).test(x.name));if(!r)throw Error('Missing N'+n);
  const {output,report}=convert(r,n);
  const stem=`simulatori-gori-route-${n}`;
  fs.writeFileSync(path.join(root,'data/imports',stem+'.json'),JSON.stringify(output,null,2)+'\n');
  fs.writeFileSync(path.join(root,'data/imports',stem+'-review.json'),JSON.stringify(report,null,2)+'\n');
  console.log(stem,`${report.pointCount} points, ${report.voiceCheckpointCount} voice checkpoints, ${report.missingAudio.length} unavailable recordings, max event/anchor offset ${report.maxAnchorOffsetMeters.toFixed(1)}m`);
}
