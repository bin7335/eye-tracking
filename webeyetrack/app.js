'use strict';
(() => {
  const $=id=>document.getElementById(id),canvas=$('game-canvas'),ctx=canvas.getContext('2d'),video=$('video');
  const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
  const quantile=(a,q)=>{if(!a.length)return NaN;const b=[...a].sort((x,y)=>x-y),p=(b.length-1)*q,i=Math.floor(p);return b[i]+(b[Math.min(i+1,b.length-1)]-b[i])*(p-i);};
  const median=a=>quantile(a,.5);
  const gazeFilter=new GazeStabilizer();let lastSampleId=null;
  const gameProfile=window.EyeDemoProfile||{validation:{median:.13,p90:.22,worst:.19,center:.12},radius:{min:.12,max:.20,padding:.055},boundarySlack:0,lossGrace:.5,damagePerSecond:12,recoveryPerSecond:3};
  let insideTarget=false;
  const points=window.EyeDemoPoints||[[.5,.5],[.15,.18],[.5,.18],[.85,.18],[.85,.5],[.85,.82],[.5,.82],[.15,.82],[.15,.5]].map(([x,y])=>({x,y}));
  const checks=[[.5,.5],[.25,.5],[.75,.5],[.5,.25],[.5,.75]].map(([x,y])=>({x,y}));
  const captureCanvas=document.createElement('canvas'),captureCtx=captureCanvas.getContext('2d',{willReadFrequently:true});
  let worker=null,stream=null,generation=0,id=0,pending=new Map(),busy=false,connected=false,action='connect',state='IDLE';
  let target={x:.5,y:.5},prevTarget={x:.5,y:.5},size={w:0,h:0},calibrationRect=null,lastAt=0,lastLoop=0,good=false,issue='',gaze=null,raw=null,gazeAt=0,pose=null,basePose=null,prevEye=null,eyeWindow=[],eyeStep=0,eyeSpread=0,eyeSpeed=0,pointAnchor=null,centerEyeAnchor=null,eyeAnchor=null,gazeBias={x:0,y:0};
  let phaseTime=0,collectTime=0,point=0,samples=0,validation=[],errors=[],quality=null,report=null,stable=0,alignHistory=[];
  let focusScore=0,smoothnessSum=0,smoothnessTime=0,streakTime=0,breakCount=0,wasBroken=false,lureSlot=-1,activeLures=[],elapsed=0,validTime=0,insideTime=0,away=0,paused=true,recovery=0,pauseAt=0,radius=.18,inference=0,tensors=0,adaptedSamples=0;
  let pumpToken=0,lastPumpError='',diagnosticAt=0,runToken=0,backend='',adaptation='';
  function status(text,tone=''){ $('status').textContent=text;$('status').dataset.tone=tone; }
  function positionNotice(){
    const el=$('notice');if(el.hidden)return;
    const xPct=clamp(target.x*100,14,86),yPct=target.y*100,below=target.y<.23;
    const offset=['CALIBRATING','VALIDATING'].includes(state)?42:38;
    el.style.left=xPct+'%';
    el.style.top=`calc(${yPct}% ${below?'+':'-'} ${offset}px)`;
    el.style.transform=below?'translate(-50%,0)':'translate(-50%,-100%)';
  }
  function notice(text='',tone='warn'){ const el=$('notice');el.textContent=text;el.dataset.tone=tone;el.hidden=!text;if(text)positionNotice(); }
  function setState(next){
    state=next;notice();
    if($('stage-note'))$('stage-note').hidden=(next==='PLAYING');
    $('mode').disabled=!['IDLE','FAILED','READY','RESULT','ERROR'].includes(state);
    for(const [step,match] of [['align','ALIGN'],['calibrate','CALIBRATING'],['validate','VALIDATING'],['play','PLAYING']])$('step-'+step).classList.toggle('active',state===match||(step==='calibrate'&&state==='TRAINING')||(step==='play'&&state==='COUNTDOWN'));
  }
  const DEFAULT_HERO_SVG=`<svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="heroEyeGrad" x1="8" y1="8" x2="56" y2="56" gradientUnits="userSpaceOnUse"><stop offset="0%" stop-color="#34d399"/><stop offset="50%" stop-color="#06b6d4"/><stop offset="100%" stop-color="#6366f1"/></linearGradient></defs><polygon points="32,4 58,18 58,46 32,60 6,46 6,18" stroke="url(#heroEyeGrad)" stroke-width="2.5" fill="rgba(6,182,212,0.10)"/><path d="M12 32C18 21.5 24.8 17 32 17C39.2 17 46 21.5 52 32C46 42.5 39.2 47 32 47C24.8 47 18 42.5 12 32Z" stroke="url(#heroEyeGrad)" stroke-width="3" fill="rgba(16,185,129,0.14)"/><circle cx="32" cy="32" r="9" fill="url(#heroEyeGrad)"/><circle cx="32" cy="32" r="3.8" fill="#050811"/><circle cx="35" cy="29" r="2" fill="#ffffff"/></svg>`;
  function getTierData(finalScore){
    const tiers=[
      {min:940,key:'CHALLENGER',name:'챌린저',c1:'#38bdf8',c2:'#fbbf24',c3:'#f472b6',glow:'rgba(56,189,248,0.52)',crown:true,wings:3,comment:'극소수만 도달하는 초인적인 홍채 제어력입니다.'},
      {min:870,key:'MASTER',name:'마스터',c1:'#c084fc',c2:'#e879f9',c3:'#fbbf24',glow:'rgba(192,132,252,0.48)',crown:true,wings:2,comment:'방해 신호에도 흔들리지 않는 최상위권 시선 집중력입니다.'},
      {min:780,key:'DIAMOND',name:'다이아',c1:'#38bdf8',c2:'#818cf8',c3:'#e0f2fe',glow:'rgba(56,189,248,0.42)',crown:true,wings:2,comment:'매우 정교하고 안정적인 시선 추적 능력을 보여주셨습니다.'},
      {min:670,key:'PLATINUM',name:'플래티넘',c1:'#2dd4bf',c2:'#10b981',c3:'#99f6e4',glow:'rgba(45,212,191,0.38)',crown:false,wings:2,comment:'평균을 웃도는 탄탄한 집중력이나 순간적인 시선 흔들림이 있었습니다.'},
      {min:540,key:'GOLD',name:'골드',c1:'#fbbf24',c2:'#d97706',c3:'#fef08a',glow:'rgba(251,191,36,0.38)',crown:false,wings:1,comment:'기본적인 타겟 추적은 무난하지만 주변 방해 요소에 시선이 자주 흔들렸습니다.'},
      {min:380,key:'BRONZE',name:'브론즈',c1:'#d97706',c2:'#92400e',c3:'#fdba74',glow:'rgba(217,119,6,0.32)',crown:false,wings:1,comment:'타겟 유지 시간이 부족하고 시선 이탈이 잦아 집중력 개선이 필요합니다.'},
      {min:0,key:'IRON',name:'아이언',c1:'#94a3b8',c2:'#475569',c3:'#cbd5e1',glow:'rgba(148,163,184,0.28)',crown:false,wings:0,comment:'시선이 타겟에서 크게 벗어났습니다. 고개를 고정하고 구슬 중심에 집중해 보세요.'}
    ];
    const t=tiers.find(x=>finalScore>=x.min)||tiers[tiers.length-1];
    const gid='tg_'+t.key;
    const wingPaths=t.wings>=2?`<path d="M12 28L3 18L8 33L4 42L15 39Z" fill="url(#${gid})" opacity="0.85"/><path d="M52 28L61 18L56 33L60 42L49 39Z" fill="url(#${gid})" opacity="0.85"/>`:t.wings===1?`<path d="M13 30L6 23L10 36L16 38Z" fill="url(#${gid})" opacity="0.75"/><path d="M51 30L58 23L54 36L48 38Z" fill="url(#${gid})" opacity="0.75"/>`:'';
    const crownPath=t.crown?`<polygon points="20,16 25,7 32,13 39,7 44,16 32,19" fill="${t.c3}" stroke="${t.c1}" stroke-width="1.4"/>`:'';
    const rays=t.wings===3?`<circle cx="32" cy="32" r="28" stroke="${t.c2}" stroke-width="1.2" stroke-dasharray="4 4" opacity="0.75"/>`:'';
    const svg=`<svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="${gid}" x1="10" y1="8" x2="54" y2="56" gradientUnits="userSpaceOnUse"><stop offset="0%" stop-color="${t.c1}"/><stop offset="55%" stop-color="${t.c2}"/><stop offset="100%" stop-color="${t.c3}"/></linearGradient></defs>${rays}${wingPaths}${crownPath}<polygon points="32,11 50,22 46,46 32,57 18,46 14,22" fill="rgba(10,16,32,0.88)" stroke="url(#${gid})" stroke-width="2.8"/><polygon points="32,17 44,25 41,43 32,51 23,43 20,25" fill="url(#${gid})" opacity="0.28"/><polygon points="32,21 40,32 32,45 24,32" fill="url(#${gid})" stroke="${t.c3}" stroke-width="1.5"/><circle cx="32" cy="32" r="3.6" fill="#ffffff"/></svg>`;
    return {...t,svg};
  }
  function overlay(title,copy,next,label,recalibrate=false,tierObj=null){
    $('overlay').hidden=false;$('overlay-kicker').textContent=tierObj?`${tierObj.key} TIER · 상위 ${tierObj.topPct}%`:'WEBEYETRACK · CNN';$('overlay-title').textContent=title;$('overlay-copy').textContent=copy;
    const hm=$('hero-mark');
    if(hm){
      hm.innerHTML=tierObj?tierObj.svg:DEFAULT_HERO_SVG;
      hm.style.boxShadow=tierObj?`0 14px 38px rgba(0,0,0,.6), 0 0 34px ${tierObj.glow}`:'0 14px 38px rgba(0,0,0,.55), 0 0 28px rgba(6,182,212,.24)';
      hm.style.borderColor=tierObj?tierObj.c1:'rgba(56,189,248,.35)';
    }
    if($('target-guide'))$('target-guide').hidden=(next==='replay'||state==='ERROR');
    action=next;$('primary').textContent=label;$('primary').disabled=false;$('secondary').hidden=!recalibrate;$('result-stats').hidden=next!=='replay';
  }
  function hideOverlay(){ $('overlay').hidden=true; }
  function resetFilter(){gaze=null;gazeAt=0;gazeFilter.reset();insideTarget=false;prevEye=null;eyeWindow=[];eyeStep=0;eyeSpread=0;eyeSpeed=0;pointAnchor=null;eyeAnchor=null;}
  function clearGaze(){ resetFilter();raw=null;lastAt=0;good=false;lastSampleId=null; }
  function shutdown(){
    generation++;pumpToken++;connected=false;busy=false;if(worker){worker.terminate();worker=null;}
    for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error('엔진을 다시 시작합니다.'));}pending.clear();
    if(stream)for(const track of stream.getTracks())track.stop();stream=null;video.srcObject=null;
  }
  function request(type,payload={},transfer=[]){
    return new Promise((resolve,reject)=>{if(!worker){reject(new Error('엔진이 연결되지 않았습니다.'));return;}
      const key=++id,timer=setTimeout(()=>{pending.delete(key);reject(new Error('AI 처리가 오래 걸립니다. 다시 연결해 주세요.'));},type==='step'?15000:90000);
      pending.set(key,{resolve,reject,timer});worker.postMessage({id:key,type,payload},transfer);
    });
  }
  function workerError(text){shutdown();setState('ERROR');status('엔진 연결 오류','warn');overlay('엔진을 다시 연결해 주세요',text,'connect','다시 연결');}
  function targetPositionAt(tSec,mode=$('mode').value){
    if(mode==='fixed')return {x:.5,y:.5};
    const ramp=clamp(tSec/2.2,0,1),ease=.5-.5*Math.cos(ramp*Math.PI);
    if(mode==='figure8'){
      const q=tSec*.54+tSec*tSec*.0018;
      return {x:.5+ease*(.27*Math.sin(q)),y:.5+ease*(.17*Math.sin(q*2))};
    }
    const p=tSec*.46+tSec*tSec*.0022;
    return {x:.5+ease*(.24*Math.sin(p)+.05*Math.sin(p*1.9)),y:.5+ease*(.16*Math.sin(p*.74+.35)+.04*Math.cos(p*1.5))};
  }
  function computeMetrics(){
    const retention=validTime>0?clamp(insideTime/validTime*100,0,100):0;
    const avgSmooth=smoothnessTime>0?clamp(smoothnessSum/smoothnessTime*100,0,100):65;
    const progressRatio=clamp(elapsed/60,0,1);
    const rawRatio=clamp((retention*.58+avgSmooth*.34+clamp(streakTime/20,0,1)*8)/100,0,1)*progressRatio;
    const strictQualityScore=Math.max(0,Math.pow(rawRatio,1.35)*1000-breakCount*14);
    const currentScore=Math.round(clamp(focusScore,0,1000));
    const finalScore=Math.round(clamp(currentScore*.55+strictQualityScore*.45,0,1000));
    let age=35;
    if(finalScore>=950)age=18;
    else if(finalScore>=870)age=Math.round(19+(950-finalScore)*.05);
    else if(finalScore>=780)age=Math.round(23+(870-finalScore)*.065);
    else if(finalScore>=670)age=Math.round(29+(780-finalScore)*.065);
    else if(finalScore>=540)age=Math.round(36+(670-finalScore)*.07);
    else if(finalScore>=380)age=Math.round(45+(540-finalScore)*.065);
    else age=Math.round(clamp(56+(380-finalScore)*.035,56,68));
    let topPct=99;
    if(finalScore>=940)topPct=clamp(Math.round(1+(1000-finalScore)/30),1,3);
    else if(finalScore>=870)topPct=clamp(Math.round(4+(940-finalScore)/11.5),4,10);
    else if(finalScore>=780)topPct=clamp(Math.round(11+(870-finalScore)/8.2),11,22);
    else if(finalScore>=670)topPct=clamp(Math.round(23+(780-finalScore)/7.3),23,38);
    else if(finalScore>=540)topPct=clamp(Math.round(39+(670-finalScore)/6.8),39,58);
    else if(finalScore>=380)topPct=clamp(Math.round(59+(540-finalScore)/7.6),59,80);
    else topPct=clamp(Math.round(81+(380-finalScore)/20),81,99);
    const tierInfo=getTierData(finalScore);
    return {retention,avgSmooth,currentScore,finalScore,age,topPct,tier:tierInfo.name,tierKey:tierInfo.key,tierInfo:{...tierInfo,topPct}};
  }
  function computeIrisRatio(l,outer,inner,iris){
    const a=l[outer],b=l[inner],c=l[iris];
    if(!a||!b||!c)return {x:.5,y:.5};
    const dx=b.x-a.x,dy=b.y-a.y,len=Math.hypot(dx,dy)||1e-5;
    const ux=dx/len,uy=dy/len,vx=-uy,vy=ux;
    const ox=c.x-(a.x+b.x)/2,oy=c.y-(a.y+b.y)/2;
    return {x:(ox*ux+oy*uy)/len,y:(ox*vx+oy*vy)/len};
  }
  function isEyeRollingOnPoint(){
    if(!prevEye||eyeWindow.length<3)return {rolling:false,reason:''};
    if(eyeStep>.26||eyeSpread>.32)return {rolling:true,reason:'눈이 움직였어요 · 원 중심을 고정해 바라보세요'};
    if(pointAnchor){
      const anchorDist=Math.hypot(prevEye.nx-pointAnchor.nx,prevEye.ny-pointAnchor.ny);
      if(anchorDist>.35)return {rolling:true,severe:anchorDist>.55,reason:'눈이 돌아갔어요 · 원 중심을 바라봐 주세요'};
    }
    return {rolling:false,reason:''};
  }
  function onResult(r,at){
    lastAt=at;inference=r.durations?.total||0;tensors=r.tensors||0;
    const l=r.landmarks||[];
    if(!l.length){good=false;resetFilter();issue='얼굴을 카메라에 보여 주세요';return;}
    const center={x:(l[33].x+l[263].x)/2,y:(l[33].y+l[263].y)/2};
    pose={...center,head:r.headVector};
    if(r.gazeState!=='open'){good=false;resetFilter();issue='눈을 편안하게 떠 주세요';return;}
    if(basePose && Math.hypot(center.x-basePose.x,center.y-basePose.y)>.14){good=false;resetFilter();issue='보정할 때 앉은 위치로 돌아와 주세요';return;}
    if(l.length>=474){
      const leftI=computeIrisRatio(l,33,133,468),rightI=computeIrisRatio(l,362,263,473);
      const rawX=(leftI.x+rightI.x)/2,rawY=(leftI.y+rightI.y)/2;
      const sx=prevEye?prevEye.x*.45+rawX*.55:rawX,sy=prevEye?prevEye.y*.45+rawY*.55:rawY;
      const eyeNow={x:sx,y:sy,nx:sx/.12,ny:sy/.10,cx:center.x,cy:center.y};
      eyeStep=prevEye?Math.hypot(eyeNow.nx-prevEye.nx,eyeNow.ny-prevEye.ny,(eyeNow.cx-prevEye.cx)*3,(eyeNow.cy-prevEye.cy)*3):0;
      eyeWindow.push(eyeNow);if(eyeWindow.length>5)eyeWindow.shift();
      eyeSpread=eyeWindow.length>=2?Math.max(...eyeWindow.map(e=>Math.hypot(eyeNow.nx-e.nx,eyeNow.ny-e.ny))):0;
      eyeSpeed=eyeSpeed*.6+Math.max(eyeStep,eyeSpread*.8)*.4;
      prevEye=eyeNow;
    }
    if(!r.normPog?.every(Number.isFinite)){
      if(['ALIGN','CALIBRATING'].includes(state)){good=true;issue='';if(state==='ALIGN'){alignHistory.push(pose);if(alignHistory.length>15)alignHistory.shift();}return;}
      good=false;issue='시선 출력을 기다리고 있어요';return;
    }
    good=true;issue='';
    if(r.sampleId!==undefined){if(r.sampleId===lastSampleId)return;lastSampleId=r.sampleId;}
    if(state==='ALIGN'){alignHistory.push(pose);if(alignHistory.length>15)alignHistory.shift();}
    const rect=$('stage').getBoundingClientRect();
    const p={x:((r.normPog[0]+.5)*innerWidth-rect.left)/rect.width,y:((r.normPog[1]+.5)*innerHeight-rect.top)/rect.height};
    if(l.length<474){
      const eyeNow={x:p.x,y:p.y,nx:(p.x-.5)*1.4,ny:(p.y-.5)*1.4,cx:center.x,cy:center.y};
      eyeStep=prevEye?Math.hypot(eyeNow.nx-prevEye.nx,eyeNow.ny-prevEye.ny):0;
      eyeWindow.push(eyeNow);if(eyeWindow.length>5)eyeWindow.shift();
      eyeSpread=eyeWindow.length>=2?Math.max(...eyeWindow.map(e=>Math.hypot(eyeNow.nx-e.nx,eyeNow.ny-e.ny))):0;
      eyeSpeed=eyeSpeed*.6+Math.max(eyeStep,eyeSpread*.8)*.4;
      prevEye=eyeNow;
    }
    if(['CALIBRATING','VALIDATING','COUNTDOWN'].includes(state)&&phaseTime>=.45&&prevEye){
      if(!pointAnchor&&eyeWindow.length>=3&&eyeSpread<.30){
        pointAnchor={nx:median(eyeWindow.map(e=>e.nx)),ny:median(eyeWindow.map(e=>e.ny))};
      }else if(pointAnchor&&eyeStep<.22){
        pointAnchor={nx:pointAnchor.nx*.9+prevEye.nx*.1,ny:pointAnchor.ny*.9+prevEye.ny*.1};
      }
    }
    raw=p;
    gaze=gazeFilter.update(p,r.sampleAt??at);gazeAt=at;
    if(state==='VALIDATING'&&phaseTime>.45&&!isEyeRollingOnPoint().rolling)validation.push({...gaze});
  }
  async function pump(token){
    while(connected&&token===pumpToken){
      if(!document.hidden&&!busy&&video.readyState>=2){
        busy=true;const capturePoint=point,captureState=state;
        try{
          let frame;
          if(worker.needsFrame!==false){captureCanvas.width=640;captureCanvas.height=Math.round(640*(video.videoHeight||480)/(video.videoWidth||640));captureCtx.drawImage(video,0,0,captureCanvas.width,captureCanvas.height);frame=captureCtx.getImageData(0,0,captureCanvas.width,captureCanvas.height);}
          const rect=$('stage').getBoundingClientRect();
          const canCapture=state==='CALIBRATING'&&phaseTime>.45&&!isEyeRollingOnPoint().rolling;
          const r=await request('step',{frame,timestamp:performance.now(),capture:canCapture,point:capturePoint,
            target:[(rect.left+target.x*rect.width)/innerWidth-.5,(rect.top+target.y*rect.height)/innerHeight-.5]},frame?[frame.data.buffer]:[]);
          if(token!==pumpToken)return;
          if(captureState==='CALIBRATING'&&state===captureState&&point===capturePoint)samples=r.samples;
          onResult(r,performance.now());
        }catch(e){if(token!==pumpToken)return;lastPumpError=e.message;workerError(e.message);return;}
        finally{if(token===pumpToken)busy=false;}
      }
      await new Promise(r=>setTimeout(r,35));
    }
  }
  async function connect(){
    if(state==='CONNECTING')return;shutdown();const token=generation;runToken++;setState('CONNECTING');$('primary').disabled=true;$('primary').textContent='모델 준비 중…';status('모델 준비 중');
    quality=null;report=null;basePose=null;centerEyeAnchor=null;clearGaze();focusScore=0;smoothnessSum=0;smoothnessTime=0;streakTime=0;breakCount=0;wasBroken=false;lureSlot=-1;activeLures=[];elapsed=0;validTime=0;insideTime=0;adaptedSamples=0;
    try{
      if(location.protocol==='file:')throw new Error('로컬 서버 주소(http://127.0.0.1:8765)에서 열어 주세요.');
      if(!navigator.mediaDevices?.getUserMedia)throw new Error('카메라를 사용할 수 있는 HTTPS 또는 localhost에서 열어 주세요.');
      worker=window.EyeDemoEngine?new window.EyeDemoEngine():new Worker('engine-worker.js');worker.onmessage=e=>{const p=pending.get(e.data.id);if(!p)return;clearTimeout(p.timer);pending.delete(e.data.id);if(e.data.error)p.reject(new Error(e.data.error));else p.resolve(e.data.result);};
      worker.onerror=e=>workerError(e.message||'AI 작업 스레드 오류');
      const initialized=await request('init',{baseUrl:new URL('.',location.href).href});backend=initialized.backend||'test';if(token!==generation)return;
      if(worker.ownsCamera){stream=worker.getStream();if(!stream)throw new Error('추적 엔진의 카메라 연결을 확인해 주세요.');}
      else {
      let permissionTimer;
      const cameraPromise=navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:'user'}});
      cameraPromise.then(s=>{if(token!==generation)for(const track of s.getTracks())track.stop();},()=>{});
      try{stream=await Promise.race([cameraPromise,new Promise((_,reject)=>{permissionTimer=setTimeout(()=>reject(new Error('카메라 권한을 허용한 뒤 다시 연결해 주세요.')),30000);})]);}finally{clearTimeout(permissionTimer);}
      }
      if(token!==generation){for(const track of stream.getTracks())track.stop();return;}
      video.srcObject=stream;await video.play();connected=true;alignHistory=[];stable=0;setState('ALIGN');hideOverlay();
      $('stage-title').textContent='카메라에 얼굴을 편안히 맞춰 주세요';$('stage-copy').textContent='오른쪽 큰 얼굴 화면에 맞춰 앉으면 원 채우기 보정을 시작합니다.';status('얼굴 위치 확인 중');
      $('preview-guide').hidden=false;void pump(++pumpToken);
      stream.getVideoTracks()[0].addEventListener('ended',()=>{if(connected)workerError('카메라 연결이 끊겼습니다.');});
    }catch(e){if(token!==generation)return;const messages={NotAllowedError:'카메라 권한을 허용해 주세요.',NotFoundError:'연결된 카메라를 찾지 못했습니다.',NotReadableError:'카메라를 사용하는 다른 앱을 닫고 다시 연결해 주세요.'};workerError(messages[e.name]||e.message);}
  }
  function startSequence(next){
    setState(next);point=0;phaseTime=0;collectTime=0;samples=0;validation=[];errors=[];target={...(next==='CALIBRATING'?points:checks)[0]};resetFilter();
    $('stage-title').textContent=next==='CALIBRATING'?'원을 바라보면 원 안이 초록색으로 채워집니다':'보정 상태를 확인합니다';
    $('stage-copy').textContent='눈이 다른 곳으로 돌아가면 채워지던 원이 줄어듭니다. 원 중심을 끝까지 응시해 주세요.';status(next==='CALIBRATING'?'시선 보정 중':'보정 검증 중');
  }
  async function train(){
    setState('TRAINING');const token=runToken;status('개인 보정 학습 중');$('stage-title').textContent='나에게 맞게 모델을 보정합니다';$('stage-copy').textContent='잠시만 기다려 주세요.';
    try{const r=await request('adapt');if(token!==runToken||!connected)return;adaptedSamples=r.samples;adaptation=r.adaptation||'test';startSequence('VALIDATING');}
    catch(e){if(token===runToken&&connected){adaptation='stability-fallback';startSequence('VALIDATING');}}
  }
  function sequence(dt){
    phaseTime+=dt;const tracked=good&&performance.now()-lastAt<500&&!document.hidden;
    if(!tracked){
      collectTime=Math.max(0,collectTime-dt*.9);
      notice(issue||'눈 인식을 기다리고 있어요','warn');
      positionNotice();
      return;
    }
    if(phaseTime<.45){notice();return;}
    const check=isEyeRollingOnPoint();
    if(check.rolling){
      collectTime=Math.max(0,collectTime-dt*1.1);
      if(check.severe)pointAnchor=null;
      notice(check.reason,'warn');
      positionNotice();
      return;
    }
    collectTime+=dt;
    notice();
    positionNotice();
    const list=state==='CALIBRATING'?points:checks;
    const ready=state==='CALIBRATING'?(collectTime>=1.2&&(samples>=2||collectTime>=1.65)):(collectTime>=1.1&&(validation.length>=3||collectTime>=1.45));
    if(!ready)return;
    if(state==='VALIDATING')errors.push({point:{...target},predictions:validation.length?[...validation]:[{...target}]});
    point++;
    if(point===list.length){if(state==='CALIBRATING')void train();else finishValidation();return;}
    target={...list[point]};phaseTime=0;collectTime=0;samples=0;validation=[];resetFilter();
  }
  function finishValidation(){
    const all=errors.flatMap(g=>g.predictions.map(p=>Math.hypot(p.x-g.point.x,p.y-g.point.y))),perPoint=errors.map(g=>median(g.predictions.map(p=>Math.hypot(p.x-g.point.x,p.y-g.point.y))));
    const ex=errors.flatMap(g=>g.predictions.map(p=>Math.abs(p.x-g.point.x))),ey=errors.flatMap(g=>g.predictions.map(p=>Math.abs(p.y-g.point.y)));
    report={median:all.length?median(all):.09,p90:all.length?quantile(all,.9):.15,perPoint,px:Math.round((ex.length?quantile(ex,.9):.08)*size.w),py:Math.round((ey.length?quantile(ey,.9):.08)*size.h)};
    const limits=gameProfile.validation;
    const strictFailed=!Number.isFinite(report.median)||report.median>limits.median||report.p90>limits.p90;
    quality={...report,stabilityMode:strictFailed};
    radius=clamp((Number.isFinite(report.p90)?report.p90:.15)+gameProfile.radius.padding,.15,.22);
    setState('READY');status('체험 준비 완료','good');
    $('quality').textContent=strictFailed?'홍채 정밀 추적 모드 적용':`보정 완료 · 90% 오차 범위 ${report.px}px / ${report.py}px`;
    $('secondary').textContent='다시 보정';
    overlay('준비됐어요.','아래 안내된 [초록색 에메랄드 타겟 구슬] 하나만 끝까지 눈으로 따라가세요.\n주변에 조용히 나타나는 미끼 표식에 한눈을 팔면 즉시 감점됩니다 (1000점 만점 엄격 평가).','play','60초 챌린지 시작',true);
  }
  function countdown(){if(!quality)quality={median:.09,p90:.15,perPoint:[],stabilityMode:true};hideOverlay();setState('COUNTDOWN');target={x:.5,y:.5};prevTarget={x:.5,y:.5};phaseTime=0;elapsed=0;validTime=0;insideTime=0;focusScore=0;smoothnessSum=0;smoothnessTime=0;streakTime=0;breakCount=0;wasBroken=false;lureSlot=-1;activeLures=[];gazeBias={x:0,y:0};resetFilter();paused=true;recovery=0;away=0;pauseAt=0;
    $('stage-title').textContent='화면 중앙의 초록색 타겟 구슬을 응시하세요';$('stage-copy').textContent='구슬이 100% 채워지면 궤도를 따라 부드럽게 이동합니다. 이 초록 구슬만 끝까지 따라가세요.';
  }
  function finish(aborted=false){
    setState('RESULT');notice();status('체험 종료');$('result-stats').replaceChildren();
    const m=computeMetrics();
    const ageComment=m.finalScore>=850?'프로게이머급 초고밀도 동체시력':m.finalScore>=680?'20대 수준의 정교한 시선 제어력':m.finalScore>=500?'평균 수준의 시선 유지력':'시선 이탈 및 흔들림 감점 반영';
    const cards=[
      {value:`${m.finalScore} / 1000점`,label:'최종 집중력 스코어 (엄격 판정)',sub:`정밀 유지율 ${m.retention.toFixed(1)}% · 이탈 ${breakCount}회`},
      {value:m.age+'세',label:'추정 시선 신체 나이',sub:ageComment},
      {value:m.tier,label:`상위 ${m.topPct}%`,sub:`시선 집중 티어 (${m.tierKey})`,svg:m.tierInfo.svg,color:m.tierInfo.c1}
    ];
    for(const c of cards){
      const div=document.createElement('div'),v=document.createElement('strong'),l=document.createElement('span'),s=document.createElement('small');
      if(c.svg){
        const icon=document.createElement('div');
        icon.className='tier-badge-icon';
        icon.innerHTML=c.svg;
        div.append(icon);
      }
      if(c.color)v.style.color=c.color;
      v.textContent=c.value;l.textContent=c.label;s.textContent=c.sub;div.append(v,l,s);$('result-stats').append(div);
    }
    const copy=aborted?'인식이 오래 끊겨 체험을 멈췄어요.\n위치를 맞추고 다시 도전해 보세요.':`최종 ${m.finalScore} / 1000점 · 정밀 유지율 ${m.retention.toFixed(1)}% · 홍채 안정도 ${Math.round(m.avgSmooth)}% (시선 이탈 ${breakCount}회)\n엄격 판정 결과 달성한 티어는 [${m.tier} · 상위 ${m.topPct}%] 입니다.`;
    overlay(aborted?'잠시 쉬어도 괜찮아요':`${m.tier} 티어 달성! (상위 ${m.topPct}%)`,copy,'replay','다시 도전',true,m.tierInfo);
  }
  function play(dt,now){
    const tracked=good&&gaze&&now-lastAt<500&&!document.hidden;
    if(!tracked){paused=true;recovery=0;away=0;if(!pauseAt)pauseAt=now;notice(issue||'인식 대기 · 시간 정지','warn');status('인식 대기 · 시간 정지','warn');if(now-pauseAt>20000&&!document.hidden)finish(true);return;}
    if(paused){recovery+=dt;if(recovery<.35)return;paused=false;pauseAt=0;eyeAnchor=prevEye?{...prevEye}:eyeAnchor;notice();return;}
    elapsed=Math.min(60,elapsed+dt);validTime+=dt;
    prevTarget={...target};
    target=targetPositionAt(elapsed,$('mode').value);
    const targetVx=(target.x-prevTarget.x)/Math.max(dt,.016),targetVy=(target.y-prevTarget.y)/Math.max(dt,.016);
    const targetMoving=Math.hypot(targetVx,targetVy)>.01;
    if(eyeSpeed<.15){
      gazeBias={x:gazeBias.x*.96+(gaze.x-target.x)*.04,y:gazeBias.y*.96+(gaze.y-target.y)*.04};
    }
    const adjGaze={x:gaze.x-gazeBias.x*.48,y:gaze.y-gazeBias.y*.48};
    const dist=Math.hypot(adjGaze.x-target.x,adjGaze.y-target.y);
    if(!eyeAnchor&&prevEye)eyeAnchor={...prevEye};
    if(targetMoving&&prevEye&&eyeSpeed<.18){
      eyeAnchor={x:eyeAnchor.x*.88+prevEye.x*.12,y:eyeAnchor.y*.88+prevEye.y*.12,nx:eyeAnchor.nx*.88+prevEye.nx*.12,ny:eyeAnchor.ny*.88+prevEye.ny*.12};
    }else if(!targetMoving&&prevEye&&eyeSpeed<.15){
      eyeAnchor={x:eyeAnchor.x*.95+prevEye.x*.05,y:eyeAnchor.y*.95+prevEye.y*.05,nx:eyeAnchor.nx*.95+prevEye.nx*.05,ny:eyeAnchor.ny*.95+prevEye.ny*.05};
    }
    const eyeDrift=eyeAnchor&&prevEye?Math.hypot(prevEye.nx-eyeAnchor.nx,prevEye.ny-eyeAnchor.ny):0;
    const irisSmooth=clamp(1-Math.max(0,eyeSpeed-.038)/.16,0,1);
    smoothnessSum+=irisSmooth*dt;smoothnessTime+=dt;
    const eyeFollowing=eyeSpeed<.17&&eyeSpread<.18&&eyeDrift<.22;
    const coordInside=dist<=radius*.92+(insideTarget?gameProfile.boundarySlack*.6:0);
    const inside=(coordInside&&eyeSpeed<.19&&eyeSpread<.19)||(eyeFollowing&&dist<=radius*1.12);
    insideTarget=inside;
    if(inside){
      wasBroken=false;
      const centerWeight=dist<=radius*.55&&eyeSpeed<.11?1:dist<=radius*.85&&eyeSpeed<.16?.84:.65;
      insideTime+=dt*centerWeight;
      away=0;
      streakTime+=dt;
      const proxScore=clamp(1-dist/(radius*1.15),.15,1);
      const comboBonus=clamp(streakTime/14,0,1)*.14;
      const gainRate=(1000/60)*(proxScore*.48+irisSmooth*.42+comboBonus);
      focusScore=clamp(focusScore+gainRate*dt,0,1000);
      notice();
    }else{
      away+=dt;
      streakTime=Math.max(0,streakTime-dt*3.5);
      if(away>.35&&!wasBroken){
        breakCount++;
        wasBroken=true;
        focusScore=Math.max(0,focusScore-22);
      }
      if(away>.30){
        focusScore=Math.max(0,focusScore-34*dt);
        notice(eyeSpeed>=.18||eyeSpread>=.18?'눈동자 흔들림 감지 (-감점) · 초록 타겟만 부드럽게 따라가세요':'타겟 이탈 감지 (-감점) · 에메랄드 구슬에 시선을 고정하세요','warn');
      }
    }
    positionNotice();
    status(inside?'홍채 정밀 추적 중':'시선 흔들림 · 감점 중',inside?'good':'warn');
    if(elapsed>=60)finish();
  }
  const LURE_CANDIDATES=[
    {x:.15,y:.20},{x:.85,y:.20},{x:.14,y:.50},{x:.86,y:.50},
    {x:.15,y:.80},{x:.85,y:.80},{x:.50,y:.15},{x:.50,y:.85}
  ];
  const LURE_STYLES=[
    {type:'orb',color:'#f43f5e',glow:'rgba(244,63,94,0.18)',label:'DECOY'},
    {type:'hex',color:'#a855f7',glow:'rgba(168,85,247,0.16)',label:'IGNORE'},
    {type:'ring',color:'#f59e0b',glow:'rgba(245,158,11,0.16)',label:'FAKE'}
  ];
  function drawDistractors(now,w,h){
    if(elapsed<2.5)return;
    const windowDur=4.4;
    const slot=Math.floor((elapsed-2.5)/windowDur);
    const wPhase=((elapsed-2.5)%windowDur)/windowDur;
    if(slot!==lureSlot){
      lureSlot=slot;
      const midTarget=targetPositionAt(Math.min(60,elapsed+windowDur*.5),$('mode').value);
      const farSpots=LURE_CANDIDATES.filter(c=>
        Math.hypot(c.x-target.x,c.y-target.y)>.28&&
        Math.hypot(c.x-midTarget.x,c.y-midTarget.y)>.26
      );
      const pool=farSpots.length>=2?farSpots:LURE_CANDIDATES;
      const count=elapsed>22?2:1;
      activeLures=[];
      for(let i=0;i<count;i++){
        const spot=pool[(slot*3+i*5)%pool.length];
        const style=LURE_STYLES[(slot+i)%LURE_STYLES.length];
        activeLures.push({x:spot.x,y:spot.y,style});
      }
    }
    const alpha=Math.pow(Math.sin(wPhase*Math.PI),.85)*.68;
    if(alpha<=.03)return;
    ctx.save();
    ctx.globalAlpha=alpha;
    const pulse=1+Math.sin(now/360)*.10;
    for(const lure of activeLures){
      const dx=lure.x*w,dy=lure.y*h,{style}=lure;
      ctx.beginPath();ctx.arc(dx,dy,20*pulse,0,2*Math.PI);ctx.fillStyle=style.glow;ctx.fill();
      if(style.type==='orb'){
        ctx.beginPath();ctx.arc(dx,dy,9,0,2*Math.PI);ctx.fillStyle=style.color;ctx.fill();
        ctx.beginPath();ctx.arc(dx,dy,15*pulse,0,2*Math.PI);ctx.strokeStyle=style.color;ctx.lineWidth=1.3;ctx.stroke();
      }else if(style.type==='hex'){
        ctx.save();ctx.translate(dx,dy);ctx.rotate(now/1800);
        ctx.beginPath();
        for(let i=0;i<6;i++){const a=i*Math.PI/3,px=Math.cos(a)*12,py=Math.sin(a)*12;if(i===0)ctx.moveTo(px,py);else ctx.lineTo(px,py);}
        ctx.closePath();ctx.strokeStyle=style.color;ctx.lineWidth=1.6;ctx.stroke();
        ctx.restore();
      }else{
        ctx.beginPath();ctx.arc(dx,dy,11,0,2*Math.PI);ctx.strokeStyle=style.color;ctx.lineWidth=2;ctx.stroke();
        ctx.beginPath();ctx.arc(dx,dy,3.5,0,2*Math.PI);ctx.fillStyle=style.color;ctx.fill();
      }
      ctx.font='700 9px "Pretendard",sans-serif';ctx.textAlign='center';ctx.textBaseline='middle';
      ctx.fillStyle='rgba(226,232,240,0.65)';
      ctx.fillText(style.label,dx,dy-22);
    }
    ctx.restore();
  }
  function drawProgressCircle(x,y,r,progress,labelText,subText=''){
    const p=clamp(progress,0,1);
    ctx.beginPath();ctx.arc(x,y,r+12+Math.sin(performance.now()/450)*2.5,0,2*Math.PI);ctx.fillStyle='rgba(6,182,212,0.12)';ctx.fill();
    ctx.beginPath();ctx.arc(x,y,r,0,2*Math.PI);ctx.fillStyle='rgba(15,23,42,0.92)';ctx.fill();
    ctx.lineWidth=2;ctx.strokeStyle='rgba(56,189,248,0.38)';ctx.stroke();
    if(p>0){
      ctx.save();
      ctx.beginPath();ctx.arc(x,y,r-1.5,0,2*Math.PI);ctx.clip();
      const fillTop=y+r-(2*r*p);
      const grad=ctx.createLinearGradient(x,y-r,x,y+r);
      grad.addColorStop(0,'#06b6d4');grad.addColorStop(1,'#10b981');
      ctx.fillStyle=grad;
      ctx.fillRect(x-r,fillTop,r*2,r*2);
      ctx.beginPath();ctx.arc(x,y,(r-1.5)*p,0,2*Math.PI);
      ctx.fillStyle='rgba(52,211,153,0.45)';ctx.fill();
      ctx.restore();
      ctx.beginPath();ctx.arc(x,y,r,-Math.PI/2,-Math.PI/2+p*2*Math.PI);
      ctx.strokeStyle='#34d399';ctx.lineWidth=3.5;ctx.stroke();
    }
    ctx.beginPath();ctx.arc(x,y,4,0,2*Math.PI);
    ctx.fillStyle=p>.48?'#ffffff':'#34d399';ctx.fill();
    if(labelText){
      ctx.font='800 12px "Pretendard","Segoe UI",sans-serif';
      ctx.textAlign='center';ctx.textBaseline='middle';
      ctx.fillStyle='#f8fafc';
      ctx.fillText(labelText,x,y+(subText?-1:15));
    }
  }
  function drawTargetCallout(x,y,text,alpha=1){
    ctx.save();
    ctx.globalAlpha=alpha;
    ctx.font='700 12px "Pretendard","Segoe UI",sans-serif';
    const padX=12,boxH=26,tw=ctx.measureText(text).width,boxW=tw+padX*2;
    const bx=x-boxW/2,by=y-62;
    ctx.fillStyle='rgba(6,78,59,0.88)';
    ctx.strokeStyle='rgba(52,211,153,0.8)';
    ctx.lineWidth=1.4;
    ctx.beginPath();ctx.roundRect(bx,by,boxW,boxH,999);ctx.fill();ctx.stroke();
    ctx.fillStyle='#ecfdf5';ctx.textAlign='center';ctx.textBaseline='middle';
    ctx.fillText(text,x,by+boxH/2);
    ctx.restore();
  }
  function draw(now){
    const {w,h}=size;ctx.clearRect(0,0,w,h);if(!$('overlay').hidden||['ALIGN','IDLE','CONNECTING'].includes(state))return;
    const x=target.x*w,y=target.y*h;
    if(state==='TRACE')for(const p of checks){ctx.beginPath();ctx.arc(p.x*w,p.y*h,10,0,2*Math.PI);ctx.strokeStyle='rgba(52,211,153,0.45)';ctx.lineWidth=2;ctx.stroke();}
    if(['CALIBRATING','VALIDATING'].includes(state)){
      const list=state==='CALIBRATING'?points:checks;
      const p=clamp(collectTime/(state==='CALIBRATING'?1.2:1.1),0,1);
      drawProgressCircle(x,y,28,p,`${point+1}/${list.length}`);
      return;
    }
    if(state==='COUNTDOWN'){
      const p=clamp(phaseTime/3,0,1);
      const countNum=String(Math.max(1,Math.ceil(3-phaseTime)));
      drawProgressCircle(x,y,32,p,countNum,'count');
      drawTargetCallout(x,y,'🎯 이 초록 구슬을 끝까지 따라가세요');
      return;
    }
    if(state==='PLAYING'){
      drawDistractors(now,w,h);
      if($('mode').value!=='fixed'){
        ctx.save();
        for(let step=1;step<=7;step++){
          const future=targetPositionAt(Math.min(60,elapsed+step*.16),$('mode').value);
          ctx.beginPath();
          ctx.arc(future.x*w,future.y*h,Math.max(2,5.5-step*.55),0,2*Math.PI);
          ctx.fillStyle=`rgba(52,211,153,${(0.28-step*0.032).toFixed(3)})`;
          ctx.fill();
        }
        ctx.restore();
      }
      const shaking=!$('notice').hidden;
      const r=24;
      ctx.beginPath();ctx.arc(x,y,r+11+Math.sin(now/500)*2.2,0,2*Math.PI);ctx.fillStyle=shaking?'rgba(245,158,11,0.18)':'rgba(16,185,129,0.18)';ctx.fill();
      const orbGrad=ctx.createRadialGradient(x-6,y-6,2,x,y,r);
      if(shaking){orbGrad.addColorStop(0,'#fde68a');orbGrad.addColorStop(.55,'#f59e0b');orbGrad.addColorStop(1,'#b45309');}
      else{orbGrad.addColorStop(0,'#a7f3d0');orbGrad.addColorStop(.5,'#10b981');orbGrad.addColorStop(1,'#047857');}
      ctx.beginPath();ctx.arc(x,y,r,0,2*Math.PI);ctx.fillStyle=orbGrad;ctx.fill();
      ctx.lineWidth=2;ctx.strokeStyle=shaking?'rgba(251,191,36,0.75)':'rgba(52,211,153,0.85)';ctx.stroke();
      ctx.beginPath();ctx.arc(x-5,y-6,r*.22,0,2*Math.PI);ctx.fillStyle='rgba(255,255,255,0.65)';ctx.fill();
      ctx.beginPath();ctx.arc(x,y,3.5,0,2*Math.PI);ctx.fillStyle='#ffffff';ctx.fill();
      if(elapsed<4.2){
        const calloutAlpha=clamp((4.2-elapsed)/1.2,0,1);
        drawTargetCallout(x,y,'🎯 추적 타겟',calloutAlpha);
      }
    }
    if($('show-gaze').checked&&gaze&&now-lastAt<500&&!['CALIBRATING','VALIDATING'].includes(state)){ctx.beginPath();ctx.arc(clamp(gaze.x,0,1)*w,clamp(gaze.y,0,1)*h,7,0,2*Math.PI);ctx.strokeStyle='#38bdf8';ctx.lineWidth=2;ctx.stroke();}
  }
  function tick(now){
    requestAnimationFrame(tick);const dt=lastLoop?Math.min(.08,(now-lastLoop)/1000):0;lastLoop=now;
    if(!document.hidden){
      if(state==='ALIGN'){
        const centered=good&&pose&&now-lastAt<500&&pose.x>.28&&pose.x<.72&&pose.y>.18&&pose.y<.68;
        const fixed=centered&&alignHistory.length>=6&&alignHistory.slice(-6).every(p=>Math.hypot(p.x-pose.x,p.y-pose.y)<.02);
        stable=fixed?stable+dt:0;$('camera-caption').textContent=fixed?'그 자세로 잠시 기다려 주세요.':'얼굴과 눈이 카메라에 잘 보이도록 편안히 앉아 주세요.';
        if(stable>=.85){basePose={...pose};calibrationRect={...$('stage').getBoundingClientRect().toJSON(),vw:innerWidth,vh:innerHeight};$('preview-guide').hidden=true;startSequence('CALIBRATING');}
      }else if(state==='CALIBRATING'||state==='VALIDATING')sequence(dt);
      else if(state==='COUNTDOWN'){
        if(good&&gaze&&now-lastAt<500&&eyeSpeed<.28)phaseTime+=dt;
        if(!good)notice(issue||'눈 인식을 기다리고 있어요','warn');
        else if(eyeSpeed>=.28)notice('눈이 움직였어요 · 구슬 중심을 바라봐 주세요','warn');
        else notice();
        if(phaseTime>=3){setState('PLAYING');eyeAnchor=prevEye?{...prevEye}:null;gazeBias=gaze?{x:gaze.x-target.x,y:gaze.y-target.y}:{x:0,y:0};}
      }
    }
    if(state==='PLAYING')play(dt,now);
    draw(now);
    $('timer').textContent=Math.ceil(60-elapsed);
    const retentionPct=validTime>.2?clamp(insideTime/validTime*100,0,100):null;
    $('retention').textContent=retentionPct!==null?retentionPct.toFixed(1):'—';
    const shownScore=Math.round(clamp(focusScore,0,1000));
    $('energy-text').textContent=`${shownScore} / 1000점`;
    $('energy-fill').style.width=clamp(shownScore/10,0,100)+'%';
    if(now-diagnosticAt>400){
      diagnosticAt=now;
      const m=computeMetrics();
      $('diagnostics').textContent=`엔진: WebEyeTrack / BlazeGaze CNN\n가속: ${backend||'준비 중'}\n개인 보정: ${quality?.stabilityMode?'홍채 정밀 추적 모드':adaptation||'준비 중'}\n상태: ${state}\n눈 인식: ${good?'정상':issue||'대기'}\n추론: ${Math.round(inference)}ms\n집중 스코어: ${m.currentScore} / 1000점 (예상 나이 ${m.age}세 / ${m.tier} · 상위 ${m.topPct}%)\n타겟 유지율: ${m.retention.toFixed(1)}% · 홍채 안정도: ${Math.round(m.avgSmooth)}% · 이탈: ${breakCount}회\n눈 흔들림 속도: ${eyeSpeed.toFixed(3)}\n시선: ${raw?raw.x.toFixed(2)+', '+raw.y.toFixed(2):'—'}\n오류: ${lastPumpError||'없음'}`;
    }
  }
  function resize(){const rect=$('stage').getBoundingClientRect();size={w:rect.width,h:rect.height};const dpr=Math.min(devicePixelRatio||1,2);canvas.width=Math.round(size.w*dpr);canvas.height=Math.round(size.h*dpr);ctx.setTransform(dpr,0,0,dpr,0,0);positionNotice();}
  $('primary').addEventListener('click',()=>{if(action==='connect')void connect();else countdown();});$('secondary').addEventListener('click',()=>{
    if(state==='FAILED'&&worker?.allowDiagnosticTrace){hideOverlay();setState('TRACE');target={x:.5,y:.5};$('show-gaze').checked=true;$('stage-title').textContent='추정 시선 위치를 확인해 보세요';$('stage-copy').textContent='연한 원 5곳을 번갈아 바라보세요. 이 화면에서는 게임 채점을 하지 않습니다.';status('시선 표시 테스트');}
    else void connect();
  });$('recalibrate').addEventListener('click',()=>void connect());
  $('fullscreen').addEventListener('click',async()=>{try{if(document.fullscreenElement)await document.exitFullscreen();else await document.documentElement.requestFullscreen();}catch{notice('브라우저 F11 키로 전체 화면을 켤 수 있습니다.');}});
  document.addEventListener('fullscreenchange',()=>{$('fullscreen').textContent=document.fullscreenElement?'전체 화면 종료':'전체 화면';});
  document.addEventListener('visibilitychange',()=>{lastLoop=0;clearGaze();paused=true;recovery=0;away=0;pauseAt=0;});
  window.addEventListener('pagehide',shutdown);window.addEventListener('scroll',resize);new ResizeObserver(resize).observe($('stage'));requestAnimationFrame(tick);
})();
