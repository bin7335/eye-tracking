const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const nodes=new Map(),node=id=>{if(!nodes.has(id))nodes.set(id,{hidden:false,value:'static',textContent:'',dataset:{},style:{},classList:{toggle(){}},getContext(){return {};},getBoundingClientRect(){return {left:0,top:0,width:1000,height:800};}});return nodes.get(id);};
const profile=fs.readFileSync(__dirname+'/realeye-profile.js','utf8').replace('export default realeyeProfile;','window.EyeDemoProfile=realeyeProfile;');
const sandbox={window:{},document:{hidden:false,getElementById:node,createElement:()=>node('canvas')},performance:{now:()=>1000},innerWidth:1000,innerHeight:800,console};vm.createContext(sandbox);
vm.runInContext(profile+'\n'+fs.readFileSync(__dirname+'/gaze-filter.js','utf8'),sandbox);
let app=fs.readFileSync(__dirname+'/app.js','utf8');app=app.slice(0,app.indexOf("  $('primary').addEventListener"))+`
window.test={validate(offset){size={w:1000,h:800};errors=checks.map(point=>({point,predictions:Array.from({length:15},()=>({x:point.x+offset,y:point.y}))}));finishValidation();return {state,median:report.median,radius};},start(){countdown();setState('PLAYING');paused=false;},step(distance,dt,tracking=true){gaze={x:.5+distance,y:.5};good=tracking;lastAt=1000;play(dt,1000);return {hp,elapsed,inside:insideTarget,insideTime,paused};}};})();`;
vm.runInContext(app,sandbox);const t=sandbox.window.test;
assert.equal(t.validate(.18).state,'READY');assert.equal(t.validate(.18).radius,.22);assert.equal(t.validate(.50).state,'FAILED');
t.validate(.18);t.start();assert.equal(t.step(.21,.1).inside,true);assert.equal(t.step(.24,.1).inside,true);assert.equal(t.step(.27,.1).inside,false);assert.equal(t.step(.24,.1).inside,false);assert.equal(t.step(.20,.1).inside,true);
assert.equal(t.step(.4,1).hp,100);assert(Math.abs(t.step(.4,.4).hp-98.8)<1e-8);const before=t.step(0,0,false);const after=t.step(0,1,false);assert.equal(after.elapsed,before.elapsed);assert.equal(after.hp,before.hp);assert.equal(after.paused,true);
console.log('PASS moderate error permits booth play, large error rejects, boundary hysteresis, 1.2s loss grace, 6%/s damage, and tracking loss pauses scoring.');
