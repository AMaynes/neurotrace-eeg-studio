/*
Purpose: Checks display overlap behavior with deterministic fixtures and controlled runtime boundaries.
File Dependencies: app/display-overlap.ts, app/trace-centering.ts.
*/


import assert from "node:assert/strict";
import test from "node:test";
import { retainDisplayOverlap } from "../app/display-overlap.ts";
import { centerDisplayWindow } from "../app/trace-centering.ts";
function window(start,data,overrides={}){
 return {settingsKey:'recording/channels/filters',recordingAnchored:true,data:[Float64Array.from(data)],labels:['LA1'],units:['µV'],
  sourceIndices:[[4]],primarySourceIndices:[4],startSecs:[start],sampleRates:[2],traceBaselines:[10],envelopes:[null],...overrides};
}
test("a partial load retains every already drawn sample and does not mutate either frame",()=>{
 const old=window(10,[10,11,12,13,14,15]),next=window(9,[NaN,NaN,NaN,NaN,NaN,NaN,NaN,NaN]);
 const before=structuredClone([old,next]);const kept=retainDisplayOverlap(next,old);
 assert.deepEqual([...kept.data[0]],[NaN,NaN,10,11,12,13,14,15]);
 assert.deepEqual([old,next],before);
 assert.equal(kept.startSecs[0],9,"old data is copied at its true absolute timestamps, never stretched");
});
test("center and clipping references stay fixed across new viewports and partial prefixes",()=>{
 const old=window(10,[10,11,12]),next=window(10.5,[600,601,602],{traceBaselines:[600]});
 const kept=retainDisplayOverlap(next,old);
 assert.deepEqual([...kept.data[0]],[11,12,602]);assert.deepEqual(kept.traceBaselines,[10]);
 assert.equal(centerDisplayWindow({...kept,viewStart:10.5,viewDuration:1.5}).traceBaselines[0],10);
});
test("changed sources, channels, filters or sample grids cannot reuse stale signal",()=>{
 const old=window(10,[1,2,3]);
 for(const changed of [{settingsKey:'new-filter'}, {labels:['RA1']},{primarySourceIndices:[7]},
  {sourceIndices:[[7]]},{units:['ADC count']},{sampleRates:[4]},{startSecs:[10.25]},{recordingAnchored:false}]){
  const next=window(10,[NaN,NaN,NaN],changed);
  assert.equal(retainDisplayOverlap(next,old),next);
 }
});
test("coarse cached ranges preserve their actual extrema and recorded gaps",()=>{
 const envelope={startSec:10,bucketDurationSec:.5,minima:Float64Array.of(-4,-5,-6),maxima:Float64Array.of(6,7,8),gaps:Uint8Array.of(0,1,0)};
 const old=window(10,[1,2,3],{envelopes:[envelope]});
 const next=window(10.5,[NaN,NaN,9],{envelopes:[{...envelope,startSec:10.5,minima:Float64Array.of(NaN,NaN,8),maxima:Float64Array.of(NaN,NaN,10),gaps:Uint8Array.of(1,1,0)}]});
 const kept=retainDisplayOverlap(next,old);
 assert.deepEqual([...kept.data[0]],[2,3,9]);assert.deepEqual([...kept.envelopes[0].minima],[-5,-6,8]);
 assert.deepEqual([...kept.envelopes[0].gaps],[1,0,0]);
});
