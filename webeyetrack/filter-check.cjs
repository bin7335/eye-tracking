const assert=require('node:assert/strict'),Filter=require('./gaze-filter.js');
let seed=12345;const random=()=>{seed=(1664525*seed+1013904223)>>>0;return seed/4294967296;};
const f=new Filter(),input=[],output=[];
for(let i=0;i<600;i++){const p={x:.5+(random()-.5)*.12,y:.5+(random()-.5)*.12},v=f.update(p,i*40);if(i>30){input.push((p.x-.5)**2+(p.y-.5)**2);output.push((v.x-.5)**2+(v.y-.5)**2);}}
const rms=a=>Math.sqrt(a.reduce((s,v)=>s+v,0)/a.length),ratio=rms(output)/rms(input);assert(ratio<.55);
const spike=new Filter();for(let i=0;i<10;i++)spike.update({x:.5,y:.5},i*40);
assert.deepEqual(spike.update({x:1.2,y:-.2},400),{x:.5,y:.5});
assert.deepEqual(spike.update({x:.5,y:.5},440),{x:.5,y:.5});
const settling=[];
for(const hz of [15,30,60]){const g=new Filter();for(let i=0;i<hz;i++)g.update({x:.3,y:.5},i*1000/hz);let delay;for(let i=0;i<hz;i++){const v=g.update({x:.7,y:.5},1000+i*1000/hz);if(v.x>.66){delay=i*1000/hz;break;}}assert(delay<=550,`step at ${hz}Hz: ${delay}`);settling.push({hz,delay});}
const burst=new Filter();for(let i=0;i<10;i++)burst.update({x:.5,y:.5},i*40);
for(const [at,p]of [[400,{x:1.4,y:-.4}],[440,{x:1.4,y:-.4}],[480,{x:.5,y:.5}]])assert.deepEqual(burst.update(p,at),{x:.5,y:.5},'Two-frame burst must not move the cursor');
let previous={x:.5,y:.5};for(let at=520;at<1800;at+=40){const v=burst.update({x:1.4,y:-.4},at);assert(Math.hypot(v.x-previous.x,v.y-previous.y)<=2.4*.04+1e-9);previous=v;}
assert(previous.x>1.2&&previous.y<-.2,'Sustained off-screen errors must remain visible to validation');
const before=spike.update({x:.5,y:.5},480);assert.deepEqual(spike.update({x:1,y:1},480),before);
assert.equal(spike.update({x:NaN,y:1},500),null);
assert.deepEqual(spike.update({x:.2,y:.3},1000),{x:.2,y:.3});
spike.reset();assert.deepEqual(spike.update({x:.8,y:.7},1100),{x:.8,y:.7});
console.log(JSON.stringify({pass:true,syntheticJitterReductionPercent:Math.round((1-ratio)*100),stepSettlingMs:settling}));
