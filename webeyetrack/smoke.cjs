const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'webeyetrack-smoke-')),pending=new Map(),errors=[],consoleErrors=[];
let browser,server,ws,next=0;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function command(method,params={}){return new Promise((resolve,reject)=>{const id=++next,timer=setTimeout(()=>{pending.delete(id);reject(Error('DevTools timeout '+method));},120000);pending.set(id,{resolve:r=>{clearTimeout(timer);resolve(r);},reject:e=>{clearTimeout(timer);reject(e);}});ws.send(JSON.stringify({id,method,params}));});}
async function evaluate(expression){const r=await command('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;}
async function until(expression,timeout=15000){const end=Date.now()+timeout;while(Date.now()<end){if(await evaluate(expression))return;await sleep(150);}throw Error('Timed out '+expression);}
const fakeEngine=`class FakeWorker {
 constructor(){this.samples=new Map();this.count=0;}
 postMessage(m){setTimeout(()=>{let result;
 if(m.type==='init')result={ready:true};
 if(m.type==='adapt')result={adapted:true,samples:36};
 if(m.type==='step'){
   const l=Array.from({length:478},()=>({x:.5,y:.4}));l[33]={x:.43,y:.4};l[263]={x:.57,y:.4};
   if(m.payload.capture)this.samples.set(m.payload.point,4);
   const p=window.__flow.target,r=document.getElementById('stage').getBoundingClientRect();
   result={normPog:[(r.left+p.x*r.width)/innerWidth-.5,(r.top+p.y*r.height)/innerHeight-.5],gazeState:'open',landmarks:l,headVector:[0,0,1],durations:{total:20},samples:this.samples.get(m.payload.point)||0,tensors:90};
 }
 this.onmessage?.({data:{id:m.id,result}});
 },35);}
 terminate(){}
};window.Worker=FakeWorker;`;
(async()=>{
  server=http.createServer((req,res)=>{
    const u=new URL(req.url,'http://localhost');
    if(u.pathname==='/portrait.jpg'){res.setHeader('Content-Type','image/jpeg');res.end(fs.readFileSync(path.join(__dirname,'test-assets/portrait.jpg')));return;}
    if(u.pathname==='/worker-test'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><html><body>Actual model worker test</body></html>');return;}
    if(u.pathname==='/legacy.html'){res.setHeader('Content-Type','text/html');res.end(fs.readFileSync(path.join(__dirname,'../eye_tracking_demo.html')));return;}
    const file=path.join(__dirname,'public',u.pathname==='/'||u.pathname==='/simulation'?'index.html':u.pathname);
    if(!fs.existsSync(file)){res.writeHead(404);res.end();return;}
    res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.html')?'text/html':file.endsWith('.json')?'application/json':'application/octet-stream');
    let text=fs.readFileSync(file);
    if(u.searchParams.has('expose')&&file.endsWith('app.js'))text=text.toString().replace(/\}\)\(\);\s*$/,'window.__flow={get state(){return state},get target(){return target},get elapsed(){return elapsed},get adaptedSamples(){return adaptedSamples},get report(){return report},nearEnd(){elapsed=59.8}};})();');
    if(u.pathname==='/webgazer.html')text=text.toString().replace('src="webgazer-app.js"','src="webgazer-app.js?expose"');
    if(u.pathname==='/realeye.html')text=text.toString().replace('src="realeye-app.js"','src="realeye-app.js?expose"');
    if(u.pathname==='/simulation')text=text.toString().replace('src="app.js"','src="app.js?expose"');
    res.end(text);
  });await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
  browser=spawn('C:/Users/SONG/AppData/Local/ms-playwright/chromium_headless_shell-1217/chrome-headless-shell-win64/chrome-headless-shell.exe',['--headless=new','--remote-debugging-port=0','--user-data-dir='+profile,'--no-first-run','--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--enable-unsafe-swiftshader','about:blank'],{windowsHide:true,stdio:'ignore'});
  let port;for(let i=0;i<100;i++){try{port=fs.readFileSync(path.join(profile,'DevToolsActivePort'),'utf8').split('\n')[0];break;}catch{}await sleep(100);}if(!port)throw Error('Browser did not start');
  const pages=await(await fetch('http://127.0.0.1:'+port+'/json/list')).json();ws=new WebSocket(pages.find(p=>p.type==='page').webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
  ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);if(m.error)p.reject(Error(JSON.stringify(m.error)));else p.resolve(m.result);}else if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails);else if(m.method==='Runtime.consoleAPICalled'){const t=m.params.args.map(a=>a.description||a.value).join(' ');if(/pupil|Error|failed|Failed|404/.test(t)&&consoleErrors.length<5)consoleErrors.push(t.slice(0,1400));}};
  await command('Runtime.enable');await command('Page.enable');await command('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
  if(process.env.EYE_WEBGAZER==='1'||process.env.EYE_REALEYE==='1'){
    const portraitCamera=`navigator.mediaDevices.getUserMedia=async()=>{
      const bitmap=await createImageBitmap(await(await fetch('/portrait.jpg')).blob()),canvas=document.createElement('canvas');canvas.width=640;const imageHeight=Math.round(bitmap.height/bitmap.width*640);canvas.height=imageHeight+250;const ctx=canvas.getContext('2d');
      let stream;function paint(){if(stream&&!stream.active)return;ctx.fillStyle='white';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(bitmap,0,180,canvas.width,imageHeight);requestAnimationFrame(paint);}paint();stream=canvas.captureStream(15);return stream;
    };`;
    await command('Page.addScriptToEvaluateOnNewDocument',{source:portraitCamera});
    if(process.env.EYE_REALEYE==='1'){
      await command('Page.navigate',{url:base+'/realeye.html'});await until('document.readyState === "complete"');
      assert.equal(await evaluate('window.EyeDemoPoints.length'),17);
      await evaluate('const Engine=window.EyeDemoEngine;window.EyeDemoEngine=class extends Engine {constructor(){super();window.__realeye=this;}};document.getElementById("primary").click()');
      await until('window.__flow?.state === "CALIBRATING" || window.__flow?.state === "ERROR"',70000);
      assert.equal(await evaluate('window.__flow.state'),'CALIBRATING',await evaluate('document.getElementById("overlay-copy").textContent'));
      console.log('RealEye startup:',await evaluate('JSON.stringify({backend:__realeye.backend,points:EyeDemoPoints.length})'));
      await until('window.__flow.state === "FAILED" || window.__flow.state === "READY" || window.__flow.state === "ERROR"',150000);
      assert.equal(await evaluate('window.__flow.state'),'FAILED',await evaluate('document.getElementById("overlay-copy").textContent'));
      assert.equal(await evaluate('__flow.adaptedSamples'),85);assert.equal(await evaluate('__realeye.tracker.isCalibrated()'),true);
      assert.ok(await evaluate('Number.isFinite(__flow.report.px)&&__flow.report.px>50&&__flow.report.py>50'));
      console.log('Actual RealEye:',await evaluate('JSON.stringify({samples:__flow.adaptedSamples,report:__flow.report,trainingMs:__realeye.tracker.getLastTrainingTimeMs(),retainedImages:__realeye.samples.length})'));
      assert.equal(await evaluate('__realeye.samples.length'),0);
      await evaluate('document.getElementById("secondary").click()');assert.equal(await evaluate('__flow.state'),'TRACE');
      const shot=await command('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(__dirname,'preview-realeye-trace.png'),Buffer.from(shot.data,'base64'));
      assert.equal(await evaluate('__realeye.tracker.detectFace(new ImageData(640,480))'),null);
      await evaluate('document.getElementById("recalibrate").click()');await until('__flow.state === "CALIBRATING" || __flow.state === "ERROR"',30000);assert.equal(await evaluate('__flow.state'),'CALIBRATING');
      assert.equal(await evaluate('__realeye.tracker.isCalibrated()'),false);assert.equal(await evaluate('__realeye.samples.length'),0);
      assert.equal(errors.length,0,JSON.stringify(errors));console.log('PASS official RealEye initialization, 17-point 85-image calibration, held-out rejection, diagnostic trace, no-face handling, image cleanup, and fresh recalibration. Human gaze accuracy unmeasured.');return;
    }
    const wgBase=base.replace('127.0.0.1','localhost');await command('Page.navigate',{url:wgBase+'/webgazer.html'});await until('document.readyState === "complete"');
    await evaluate('document.getElementById("primary").click()');
    await sleep(8000);console.log('WebGazer startup:',await evaluate('JSON.stringify({state:window.__flow?.state,positions:window.webgazer?.getTracker().getPositions()?.length,status:document.getElementById("status").textContent})'));if(consoleErrors.length)console.log('WebGazer logs:',consoleErrors);
    await until('window.__flow?.state === "CALIBRATING" || window.__flow?.state === "ERROR"',70000);
    assert.equal(await evaluate('window.__flow.state'),'CALIBRATING',await evaluate('document.getElementById("overlay-copy").textContent'));
    assert.equal(await evaluate('webgazer.params.saveDataAcrossSessions'),false);
    await until('window.__flow.state === "FAILED" || window.__flow.state === "READY" || window.__flow.state === "ERROR"',65000);
    assert.equal(await evaluate('window.__flow.state'),'FAILED');
    assert.ok(await evaluate('window.__flow.adaptedSamples >= 27'));assert.ok(await evaluate('Number.isFinite(window.__flow.report.px)'));
    assert.ok(await evaluate('window.__flow.report.px > 50 && window.__flow.report.py > 50'),'Axis error summary must expose missed side targets');
    console.log('Actual WebGazer:',await evaluate('JSON.stringify({version:"3.5.3",samples:__flow.adaptedSamples,report:__flow.report,prediction:webgazer.getRegression()[0].getData().length})'));
    // A fixed portrait cannot follow calibration targets. Rejecting it is expected.
    const actualShot=await command('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(__dirname,'preview-webgazer-validation.png'),Buffer.from(actualShot.data,'base64'));
    await evaluate('window.trainingCalls=0;const record=webgazer.recordScreenPosition;webgazer.recordScreenPosition=function(...args){trainingCalls++;return record.apply(this,args);};document.getElementById("show-gaze").click();');await sleep(600);assert.equal(await evaluate('trainingCalls'),0);
    await evaluate('document.getElementById("secondary").click()');assert.equal(await evaluate('window.__flow.state'),'TRACE');await sleep(500);assert.equal(await evaluate('trainingCalls'),0);
    await evaluate('document.getElementById("recalibrate").click()');await until('window.__flow.state === "CALIBRATING" || window.__flow.state === "ERROR"',15000);assert.equal(await evaluate('window.__flow.state'),'CALIBRATING');
    assert.equal(errors.length,0,JSON.stringify(errors));
    console.log('PASS actual WebGazer load, eye features, 9-point recording, held-out rejection, no global-click training, and camera recalibration. Human gaze accuracy remains unmeasured.');return;
  }
  await command('Page.navigate',{url:base+'/worker-test'});await until('document.readyState === "complete"');
  console.log('Loading actual face model and CNN in worker...');
  const init=await evaluate(`(async()=>{
    window.engine=new Worker('/engine-worker.js');window.rpcId=0;window.waits=new Map();
    engine.onmessage=e=>{const p=waits.get(e.data.id);if(!p)return;waits.delete(e.data.id);if(e.data.error)p.reject(Error(e.data.error));else p.resolve(e.data.result);};
    window.rpc=(type,payload={},transfer=[])=>new Promise((resolve,reject)=>{const id=++rpcId;waits.set(id,{resolve,reject});engine.postMessage({id,type,payload},transfer);});
    return await rpc('init',{baseUrl:location.origin+'/'});
  })()`);assert.equal(init.ready,true);console.log('Actual init:',init);
  const inference=await evaluate(`(async()=>{
    const bitmap=await createImageBitmap(await(await fetch('/portrait.jpg')).blob());window.testCanvas=document.createElement('canvas');testCanvas.width=640;testCanvas.height=Math.round(bitmap.height/bitmap.width*640);window.testCtx=testCanvas.getContext('2d',{willReadFrequently:true});testCtx.drawImage(bitmap,0,0,testCanvas.width,testCanvas.height);
    const frame=testCtx.getImageData(0,0,testCanvas.width,testCanvas.height);return await rpc('step',{frame,timestamp:performance.now()},[frame.data.buffer]);
  })()`);assert.ok(inference.landmarks.length>0);assert.equal(inference.gazeState,'open');assert.ok(inference.normPog.every(Number.isFinite));console.log('Actual CNN inference:',JSON.stringify({gaze:inference.normPog,ms:inference.durations.total,tensors:inference.tensors}));
  const warm=await evaluate(`(async()=>{const runs=[];for(let i=0;i<10;i++){const frame=testCtx.getImageData(0,0,testCanvas.width,testCanvas.height);const r=await rpc('step',{frame,timestamp:performance.now()},[frame.data.buffer]);runs.push({ms:r.durations.total,tensors:r.tensors});}return runs;})()`);
  const timings=warm.map(r=>r.ms).sort((a,b)=>a-b);console.log('Warm actual inference:',{medianMs:Math.round((timings[4]+timings[5])/2),p90Ms:Math.round(timings[8]),tensorCounts:[...new Set(warm.map(r=>r.tensors))]});
  assert.ok(warm.every(r=>r.tensors<=inference.tensors+1),'Inference leaked tensors');
  if(process.env.EYE_WORKER_ONLY==='1'){await evaluate('engine.terminate()');assert.equal(errors.length,0);console.log('PASS actual model performance and stable tensor count.');return;}
  console.log('Running actual personal adaptation...');
  const adapted=await evaluate(`(async()=>{
    for(let point=0;point<9;point++)for(let i=0;i<4;i++){
      const frame=testCtx.getImageData(0,0,testCanvas.width,testCanvas.height);
      await rpc('step',{frame,timestamp:performance.now()+point*2000+i*300,capture:true,point,target:[(point%3-1)*.25,(Math.floor(point/3)-1)*.25]},[frame.data.buffer]);
    }
    return await rpc('adapt');
  })()`);assert.equal(adapted.adapted,true);assert.equal(adapted.samples,36);console.log('Actual adaptation:',adapted);
  const noFace=await evaluate(`(async()=>{testCtx.fillStyle='black';testCtx.fillRect(0,0,testCanvas.width,testCanvas.height);const frame=testCtx.getImageData(0,0,testCanvas.width,testCanvas.height);return await rpc('step',{frame,timestamp:performance.now()+30000},[frame.data.buffer]);})()`);
  assert.equal(noFace.landmarks.length,0);assert.equal(noFace.gazeState,'closed');await evaluate('engine.terminate()');
  await command('Page.navigate',{url:base+'/'});await until('document.readyState === "complete"');
  const shot=await command('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(__dirname,'preview-webeyetrack.png'),Buffer.from(shot.data,'base64'));
  assert.ok(await evaluate('document.querySelector("footer").textContent.includes("WebEyeTrack")'));
  await command('Page.addScriptToEvaluateOnNewDocument',{source:fakeEngine});await command('Page.navigate',{url:base+'/simulation'});await until('document.readyState === "complete"');await evaluate('document.getElementById("primary").click()');
  await until('window.__flow?.state === "READY" || window.__flow?.state === "FAILED" || window.__flow?.state === "ERROR"',65000);assert.equal(await evaluate('window.__flow.state'),'READY');
  await evaluate('document.getElementById("primary").click()');await until('window.__flow.state === "PLAYING"');await sleep(700);assert.ok(await evaluate('window.__flow.elapsed > 0'));
  await evaluate('window.__flow.nearEnd()');await until('window.__flow.state === "RESULT"');await evaluate('document.getElementById("primary").click()');await until('window.__flow.state === "PLAYING"');
  assert.equal(errors.length,0,JSON.stringify(errors));console.log('PASS actual CNN load/inference/adaptation/no-face handling and simulated UI calibration/validation/game/replay. This is not human gaze accuracy measurement.');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{try{if(ws?.readyState===1)await command('Browser.close');}catch{}ws?.close();browser?.kill();server?.close();});
