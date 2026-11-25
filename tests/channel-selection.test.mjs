/*
Purpose: Exercise the actual page selection handlers together, without signal or file work.
File Dependencies: app/channel-layout.ts, app/page.tsx.
*/


import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { buildChannelRowLayout, channelPlotGeometry, channelRowFromFraction } from "../app/channel-layout.ts";
const page=await readFile(new URL('../app/page.tsx',import.meta.url),'utf8');
const tree=ts.createSourceFile('page.tsx',page,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const nodes=[];
function walk(node){nodes.push(node);ts.forEachChild(node,walk);}walk(tree);
function variable(name){return nodes.find(node=>ts.isVariableDeclaration(node)&&node.name.getText(tree)===name).initializer.getText(tree);}
function compile(expression,scope){
 const js=ts.transpile(`const handler=${expression};`,{target:ts.ScriptTarget.ES2022});
 return new Function(...Object.keys(scope),js+'\nreturn handler;')(...Object.values(scope));
}
function harness(hit=3,readable=true,options={}){
 const state={sources:[0,1,2],active:true,focused:0,cursor:null,selection:null,markOnset:null,annotations:[],zooms:[],notices:[]};
 const rect={left:20,top:100,width:1000,height:600,right:1020,bottom:700};
 const labels=options.empty?[]:["LA1","LA2","RA1","RA2"];
 const layout=buildChannelRowLayout(labels,true);
 const expandedChannels=options.expanded??false;
 const scrollTop=options.scrollTop??0;
 const geometry=channelPlotGeometry(layout,rect.height-28,expandedChannels);
 const clamp=(v,lo,hi)=>Math.max(lo,Math.min(hi,v));
 const frames=new Map();let frameId=0;
 const canvas={getBoundingClientRect:()=>rect,setPointerCapture(){state.captured=true;}};
 const scope={useCallback:fn=>fn,clamp,CHANNEL_RAIL_HEADER_HEIGHT:28,channelRowLayout:layout,channelPlotGeometry,channelRowFromFraction,
  expandedChannels,waveformVerticalViewport:null,waveformScrollRef:{current:{scrollTop}},channelScrollOffsetRef:{current:scrollTop},
  setSpectrogramChannels:value=>{state.sources=typeof value==='function'?value(state.sources):value;},
  setChannelSelectionActive:value=>{state.active=value;},setFocusedChannel:value=>{state.focused=value;},
  displayReadoutReady:readable,display:{data:labels.map(()=>[]),labels,sourceIndices:labels.map((_,i)=>[i])},
  playing:false,timeFromPointer:(event)=>clamp((event.clientX-rect.left)/rect.width,0,1)*20,
  pointerRef:{current:null},pendingCursorRef:{current:null},cursorFrameRef:{current:null},inspectionMode:options.inspection??false,
  setPlaying(){},setCursorTime(value){state.cursor=value;},setSpectrogramAnchor(value){state.anchor=value;},
  setCursorLocked(value){state.locked=value;},setInspectionRange(value){state.inspectionRange=value;},notifyTutorialAction(){},
  setInspectionDragging(value){state.inspectionDragging=value;},setSelection(value){state.selection=value;scope.selection=value;},
  setToast(value){state.notices.push(value);},formatClock:String,formatDisplayChannelLabel:String,
  markOnset:null,setMarkOnset(value){state.markOnset=value;scope.markOnset=value;},activeTool:options.tool??'cursor',
  setActiveTool(value){scope.activeTool=value;},addAnnotation(...args){state.annotations.push(args);},
  LABEL_BY_ID:new Map([['ictal',{id:'ictal',geometry:'interval',category:'Seizure'}]]),
  zoomToTimeRange(...args){state.zooms.push(args);},changeZoomView(...args){state.zooms.push(args);},
  canvasRef:{current:canvas},selection:null,setDragGhost(value){state.ghost=typeof value==='function'?value(state.ghost):value;},
  window:{requestAnimationFrame(fn){frames.set(++frameId,fn);return frameId;},cancelAnimationFrame(id){frames.delete(id);}},
 };
 for(const name of ['clearChannelSelection','channelRowFromClientY','inspectionBoxFromPointer','waveformZoomForInspectionBox']){
  scope[name]=compile(variable(name),scope);
 }
 const invoke=(name,event)=>compile(variable(name),scope)(event);
 const workspace=nodes.find(node=>ts.isJsxAttribute(node)&&node.name.getText(tree)==='onPointerDownCapture'
  &&node.initializer.getText(tree).includes('clearChannelSelection'));
 const clickAway=compile(workspace.initializer.expression.getText(tree),scope);
 const rowY=row=>rect.top+28+geometry.yForUnit(layout.rowStartUnits[row]+.5)-scrollTop;
 const event=(x,y)=>({button:0,clientX:x,clientY:y,pointerId:1,currentTarget:canvas,altKey:false});
 const down=(x,y)=>invoke('onWavePointerDown',event(x,y));
 const up=(x,y)=>invoke('onWavePointerUp',event(x,y));
 return{state,rect,geometry,layout,rowY,clear:scope.clearChannelSelection,down,up,
  point(y=hit===null?rect.top+40:rowY(hit),x=rect.left+600){down(x,y);up(x,y);},
  move(x,y){invoke('onWavePointerMove',event(x,y));for(const [id,fn] of frames){frames.delete(id);fn();}},
  cancel(){invoke('onWavePointerCancel',event(rect.left,rect.top));},
  drop(x,y){const e={...event(x,y),preventDefault(){},dataTransfer:{types:['application/x-neurotrace-label'],getData:()=> 'ictal'}};
   invoke('onLabelDragOver',e);invoke('onLabelDrop',e);},
  clickAway(preserve=false,button=0){clickAway({button,target:{closest:()=>preserve?{}:null}});},
  group(shiftKey){
   const handler=nodes.find(node=>ts.isJsxAttribute(node)&&node.name.getText(tree)==='onClick'
    &&node.initializer.getText(tree).includes('const next = event.shiftKey'));
   compile(handler.initializer.expression.getText(tree),{...scope,spectrogramChannels:state.sources,sources:[0,1,2],
    selected:[0,1,2].every(index=>state.sources.includes(index)),startRow:0})({shiftKey});
  }
 };
}

test('clearing a selected group removes both selection representations',()=>{
 const ui=harness();ui.clear();assert.deepEqual(ui.state.sources,[]);assert.equal(ui.state.active,false);
});
test('clicking another waveform row replaces the complete group with only the clicked row',()=>{
 const ui=harness(3);ui.point();assert.deepEqual(ui.state.sources,[]);assert.equal(ui.state.active,true);assert.equal(ui.state.focused,3);
});
test('clicking a recording gap pins time with the nearest channel; empty workspace still clears selection',()=>{
 const gap=harness(null);gap.point();assert.deepEqual(gap.state.sources,[]);assert.equal(gap.state.active,true);
 assert.equal(gap.state.focused,0);assert.equal(gap.state.cursor,12);assert.equal(gap.state.locked,true);
 const blank=harness();blank.clickAway();assert.deepEqual(blank.state.sources,[]);assert.equal(blank.state.active,false);
});
test('analysis controls preserve the group they operate on, and right-click does not clear it',()=>{
 const ui=harness();ui.clickAway(true);assert.deepEqual(ui.state.sources,[0,1,2]);assert.equal(ui.state.active,true);
 ui.clickAway(false,2);assert.deepEqual(ui.state.sources,[0,1,2]);
});
test('Shift-click toggles a complete group off without leaving its first row selected',()=>{
 const ui=harness();ui.group(true);assert.deepEqual(ui.state.sources,[]);assert.equal(ui.state.active,false);
 ui.group(false);assert.deepEqual(ui.state.sources,[0,1,2]);assert.equal(ui.state.active,true);
});

test('clicking away while new signal is loading still clears the old channel group',()=>{
 const ui=harness(3,false);ui.point();assert.deepEqual(ui.state.sources,[]);assert.equal(ui.state.active,false);
});


test('header, inter-group gap, and bottom whitespace all support clicks and label drops',()=>{
 const ui=harness();
 const gapY=ui.rowY(1)+ui.geometry.rowHeight/2+10;
 for(const [y,row] of [[ui.rect.top+2,0],[gapY,1],[ui.rect.bottom-2,3]]){
  ui.point(y);assert.equal(ui.state.focused,row);assert.equal(ui.state.cursor,12);
  ui.drop(ui.rect.left+250,y);
  const [label,time,,intent,channel]=ui.state.annotations.at(-1);
  assert.equal(label.id,'ictal');assert.equal(time,5);assert.equal(intent,'instance');assert.equal(channel,row);
 }
 const count=ui.state.annotations.length;
 ui.drop(ui.rect.left-1,gapY);ui.drop(ui.rect.left,ui.rect.bottom+1);
 assert.equal(ui.state.annotations.length,count,'outside the recording stays excluded');
});

test('a range drag can start, cross, and finish in empty recording space',()=>{
 const ui=harness();
 ui.down(ui.rect.left+100,ui.rect.top+2);
 ui.move(ui.rect.left+300,ui.rowY(1)+20);
 assert.deepEqual(ui.state.selection,{start:2,end:6});
 ui.move(ui.rect.left+750,ui.rect.bottom-2);
 ui.up(ui.rect.left+750,ui.rect.bottom-2);
 assert.deepEqual(ui.state.selection,{start:2,end:15});
 ui.drop(ui.rect.left+400,ui.rect.top+40);
 assert.deepEqual(ui.state.annotations[0].slice(1),[2,15,'windowed',0]);
});

test('seizure marking and box zoom both start and finish away from channel rows',()=>{
 const marking=harness(null,true,{tool:'seizure'});
 marking.point(marking.rect.top+2,marking.rect.left+100);
 assert.equal(marking.state.markOnset,2);
 marking.point(marking.rect.bottom-2,marking.rect.left+500);
 assert.deepEqual(marking.state.annotations[0].slice(1),[2,10,'native',3]);
 assert.equal(marking.state.markOnset,null);
 const zoom=harness(null,true,{inspection:true});
 zoom.down(zoom.rect.left+100,zoom.rect.top+2);
 zoom.move(zoom.rect.left+500,zoom.rect.bottom-2);
 zoom.up(zoom.rect.left+500,zoom.rect.bottom-2);
 assert.equal(zoom.state.zooms.length,1);
 assert.deepEqual(zoom.state.zooms[0].slice(0,2),[2,10]);
 assert.ok(zoom.state.zooms[0][2].verticalViewport.bottom>zoom.state.zooms[0][2].verticalViewport.top);
});

test('scrolled gaps keep channel context and canceled drags cannot place a selection',()=>{
 const ui=harness(null,true,{expanded:true,scrollTop:35});
 const y=ui.rowY(1)+ui.geometry.rowHeight/2+5;
 ui.point(y);assert.equal(ui.state.focused,1);
 ui.down(ui.rect.left+100,y);ui.cancel();ui.move(ui.rect.left+500,y);ui.up(ui.rect.left+500,y);
 assert.equal(ui.state.selection,null);assert.equal(ui.state.annotations.length,0);
 const empty=harness(null,true,{empty:true});empty.point();assert.equal(empty.state.cursor,null);
});
