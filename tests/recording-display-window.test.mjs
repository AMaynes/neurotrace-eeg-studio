/*
Purpose: Checks recording display window behavior with deterministic fixtures and controlled runtime boundaries.
File Dependencies: app/matlab-display-window.ts, app/recording-display-window.ts, app/trace-centering.ts.
*/


import assert from "node:assert/strict";
import test from "node:test";
import { buildMatlabDisplayWindow } from "../app/matlab-display-window.ts";
import { createRecordingDisplayCache } from "../app/recording-display-window.ts";
import { centerDisplayWindow } from "../app/trace-centering.ts";

function fixture(rates = [1000,1000,1000], duration = 80) {
 const arrays=rates.map((rate,row)=>Float32Array.from({length:rate*duration},(_,i)=>{
  const t=i/rate;
  return (t<35? 0:600)+row*100+20*Math.sin(t*17+row)+ (i===Math.floor(42.123*rate)?250:0);
 }));
 const reads=[];
 return {arrays,reads,meta:{channelCount:rates.length,channelLabels:rates.map((_,i)=>`LA${i+1}`),
  channelUnits:rates.map(()=>"µV"),sampleRates:rates,durationSec:duration},
  async getWindow(start,span,selected,options={}) {
   options.signal?.throwIfAborted(); reads.push({start,span,selected:[...selected]});
   const first=selected.map(ch=>Math.floor(start*rates[ch]+1e-8));
   return {data:selected.map((ch,i)=>arrays[ch].slice(first[i],first[i]+Math.ceil(span*rates[ch]))),
    sampleRates:selected.map(ch=>rates[ch]),channelStartSecs:selected.map((ch,i)=>first[i]/rates[ch]),
    startSec:start,durationSec:span,channelIndices:[...selected],channelLabels:selected.map(ch=>this.meta.channelLabels[ch]),
    channelUnits:selected.map(()=>"µV")};
  }};
}
const open=(source,cache,start,extra={},options={})=>buildMatlabDisplayWindow({source,startSec:start,durationSec:20,
 pixelWidth:16384,channelIndices:source.meta.sampleRates.map((_,i)=>i),montage:"referential",recordingAnchored:true,...extra},
 {recordingCache:cache,fallbackToMainThread:true,...options});
function samples(window,row=0) {
 const envelope=window.envelopes[row];
 const step=envelope?.bucketDurationSec??1/window.sampleRates[row];
 return new Map([...window.data[row]].map((value,i)=>[Math.round((window.startSecs[row]+i*step)*1e9),
  [value,envelope?.minima[i],envelope?.maxima[i],envelope?.gaps[i]]]));
}
function assertOverlap(a,b) {
 for(let row=0;row<a.data.length;row++) {
  const before=samples(a,row),after=samples(b,row); let count=0;
  for(const [time,value] of before)if(after.has(time)){assert.deepEqual(after.get(time),value,`row ${row}, time ${time/1e9}`);count++;}
  assert.ok(count>10,"overlapping samples must retain the identical global timestamps");
 }
 assert.deepEqual(a.traceBaselines,b.traceBaselines,"vertical references must stay fixed while panning");
}

test("small left/right pans preserve exact samples, centers and clipping across a large DC step",async()=>{
 const source=fixture(),cache=createRecordingDisplayCache();
 const a=await open(source,cache,30.0003);
 const b=await open(source,cache,32.0017);
 const c=await open(source,cache,29.9991);
 assertOverlap(a,b);assertOverlap(a,c);
 const centered=centerDisplayWindow({...b,viewStart:32.0017,viewDuration:20});
 assert.deepEqual(centered.traceBaselines,a.traceBaselines);
 assert.notEqual(b.traceBaselines[0],600,"panning into the DC step must not recenter around it");
});

test("pan reads only missing canonical blocks and reverse pans reuse every loaded block",async()=>{
 const source=fixture(),cache=createRecordingDisplayCache();
 await open(source,cache,30); const initial=source.reads.length;
 await open(source,cache,31);
 assert.ok(source.reads.length-initial<=1,"a one-second pan must not reread the overlapping twenty seconds");
 const after=source.reads.length;
 await open(source,cache,30); assert.equal(source.reads.length,after);
 assert.ok(source.reads.every(read=>read.span<34),"all reads are bounded blocks, not full viewports");
});

test("global FIR phase and true file boundaries preserve dense-view samples across opposite-phase pans",async()=>{
 const source=fixture([2000,2000,2000]),cache=createRecordingDisplayCache();
 const a=await open(source,cache,30.0005,{pixelWidth:1000});
 const b=await open(source,createRecordingDisplayCache(),30.001,{pixelWidth:1000});
 assert.equal(a.factors[0],2);assertOverlap(a,b);
 const eof=await open(source,cache,65,{pixelWidth:1000});
 const nearEof=await open(source,cache,65.1005,{pixelWidth:1000});
 assertOverlap(eof,nearEof);
});

test("custom filter context is recording-aligned for recorded, average and bipolar views",async()=>{
 for(const montage of ["referential","average","bipolar"]) {
  const source=fixture(),cache=createRecordingDisplayCache();
  const settings={montage,displayFilters:{enabled:true,highPassHz:1,lowPassHz:80,notchHz:0}};
  const a=await open(source,cache,30.0003,settings), b=await open(source,createRecordingDisplayCache(),32.0017,settings);
  assertOverlap(a,b);
 }
});

test("coarse global bins retain the exact same representatives, extrema and gaps during panning",async()=>{
 const source=fixture(),cache=createRecordingDisplayCache();
 const extra={durationSec:50,pixelWidth:10};
 const a=await open(source,cache,10,extra),b=await open(source,cache,11,extra);
 assert.ok(a.envelopes[0]); assertOverlap(a,b);
});

test("cached right-hand islands appear in the first partial result before missing left blocks load",async()=>{
 const source=fixture([1000,1000,1000],200),cache=createRecordingDisplayCache();
 const a=await open(source,cache,100);
 const partials=[];
 const b=await open(source,cache,90,{}, {onPartial:part=>partials.push(part)});
 assert.ok(partials.length);
 const known=samples(a),first=samples(partials[0]);let overlap=0;
 for(const [time,value] of known)if(first.has(time)&&Number.isFinite(value[0])){
  assert.deepEqual(first.get(time),value);overlap++;
 }
 assert.ok(overlap>100,"a pending left block must not blank any already loaded right-hand samples");
 assertOverlap(a,b);
});

test("mixed-rate rows each keep their own source-aligned timestamps and values",async()=>{
 const source=fixture([256,512,128]),cache=createRecordingDisplayCache();
 assertOverlap(await open(source,cache,30.0003),await open(source,cache,31.0017));
});

test("cancellation stops missing reads without changing already cached samples",async()=>{
 const source=fixture(),cache=createRecordingDisplayCache();
 const a=await open(source,cache,30);const controller=new AbortController();
 controller.abort();
 await assert.rejects(open(source,cache,40,{}, {signal:controller.signal}),{name:"AbortError"});
 assertOverlap(a,await open(source,cache,31));
 assert.ok(cache.samples.byteLength<=48*1024*1024&&cache.summaries.byteLength<=128*1024*1024);
});

test("empty and incomplete EOF bins remain explicit gaps and never expose infinite extrema",async()=>{
 const source=fixture(),cache=createRecordingDisplayCache();const partials=[];
 const complete=await open(source,cache,61,{durationSec:20,pixelWidth:100},{onPartial:window=>partials.push(window)});
 for(const window of [...partials,complete]) for(const envelope of window.envelopes)if(envelope){
  assert.ok([...envelope.minima,...envelope.maxima].every(value=>Number.isFinite(value)||Number.isNaN(value)));
 }
});

test("centered views outside file edges retain true sample timestamps without fabricated zero samples",async()=>{
 const source=fixture(),cache=createRecordingDisplayCache();
 const normal=await open(source,cache,0),left=await open(source,cache,-10);
 assertOverlap(normal,left);
 assert.equal(left.startSecs[0],1/1000);
 const end=await open(source,cache,70), shifted=await open(source,cache,71.0001);
 assertOverlap(end,shifted);
 assert.ok(source.reads.every(read=>read.start>=0));
});
