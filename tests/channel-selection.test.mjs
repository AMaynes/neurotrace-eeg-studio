/** Exercise the actual page selection handlers together, without signal or file work. */
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
const page=await readFile(new URL('../app/page.tsx',import.meta.url),'utf8');
const tree=ts.createSourceFile('page.tsx',page,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const nodes=[];
function walk(node){nodes.push(node);ts.forEachChild(node,walk);}walk(tree);
function variable(name){return nodes.find(node=>ts.isVariableDeclaration(node)&&node.name.getText(tree)===name).initializer.getText(tree);}
function compile(expression,scope){
 const js=ts.transpile(`const handler=${expression};`,{target:ts.ScriptTarget.ES2022});
 return new Function(...Object.keys(scope),js+'\nreturn handler;')(...Object.values(scope));
}
function harness(hit=3,readable=true){
 const state={sources:[0,1,2],active:true,focused:0,hit};
 const scope={useCallback:fn=>fn,setSpectrogramChannels:value=>{state.sources=typeof value==='function'?value(state.sources):value;},
  setChannelSelectionActive:value=>{state.active=value;},setFocusedChannel:value=>{state.focused=value;},
  displayReadoutReady:readable,display:{data:[[],[],[],[]]},channelRowFromClientY:()=>state.hit,
  playing:false,timeFromPointer:()=>12,pointerRef:{current:null},inspectionMode:false,
  setPlaying(){},setCursorTime(){},setSpectrogramAnchor(){},setCursorLocked(){},setInspectionRange(){},notifyTutorialAction(){}
 };
 scope.clearChannelSelection=compile(variable('clearChannelSelection'),scope);
 const pointer=compile(variable('onWavePointerDown'),scope);
 const workspace=nodes.find(node=>ts.isJsxAttribute(node)&&node.name.getText(tree)==='onPointerDownCapture'
  &&node.initializer.getText(tree).includes('clearChannelSelection'));
 const clickAway=compile(workspace.initializer.expression.getText(tree),scope);
 return{state,clear:scope.clearChannelSelection,
  point(){pointer({button:0,clientX:10,clientY:20,pointerId:1,currentTarget:{getBoundingClientRect:()=>({}),setPointerCapture(){}}});},
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
test('clicking a recording gap or empty workspace leaves every channel unselected',()=>{
 const gap=harness(null);gap.point();assert.deepEqual(gap.state.sources,[]);assert.equal(gap.state.active,false);
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
