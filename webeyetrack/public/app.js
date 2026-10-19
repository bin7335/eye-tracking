// Screen-normalized coordinates. No clipping or target-dependent attraction.
class GazeStabilizer {
  constructor(){this.reset();}
  reset(){this.history=[];this.value=null;this.at=null;this.candidate=null;this.confirmed=null;}
  update(p,at){
    if(!Number.isFinite(p.x)||!Number.isFinite(p.y)||!Number.isFinite(at))return null;
    if(this.at!==null&&at<=this.at)return this.value&&{...this.value};
    if(this.at===null||at-this.at>400){this.reset();this.history.push({...p});this.value={...p};this.at=at;return {...this.value};}
    const dt=(at-this.at)/1000;this.at=at;
    // A distant prediction must persist in the same area. A two-frame burst
    // used to pass the median and activate the fastest smoothing mode.
    const distant=Math.hypot(p.x-this.value.x,p.y-this.value.y)>.18;
    if(distant&&(!this.confirmed||Math.hypot(p.x-this.confirmed.x,p.y-this.confirmed.y)>.09)){
      if(!this.candidate||Math.hypot(p.x-this.candidate.x,p.y-this.candidate.y)>.09){this.candidate={...p,since:at,count:1};}
      else this.candidate.count++;
      if(this.candidate.count<3||at-this.candidate.since<80)return {...this.value};
      this.confirmed={x:this.candidate.x,y:this.candidate.y};this.candidate=null;
      this.history=[{...p},{...p}];
    }else{
      this.candidate=null;
      if(!distant)this.confirmed=null;
    }
    this.history.push({...p});if(this.history.length>3)this.history.shift();
    // Wait for a full window; two frames cannot distinguish a spike from a move.
    if(this.history.length<3)return {...this.value};
    const middle=k=>this.history.map(v=>v[k]).sort((a,b)=>a-b)[1];
    const m={x:middle('x'),y:middle('y')};
    const distance=Math.hypot(m.x-this.value.x,m.y-this.value.y);
    const tau=distance>.12?.065:.20,alpha=1-Math.exp(-dt/tau);
    let dx=(m.x-this.value.x)*alpha,dy=(m.y-this.value.y)*alpha;
    const step=Math.hypot(dx,dy),limit=2.4*Math.min(dt,.08);
    if(step>limit){dx*=limit/step;dy*=limit/step;}
    this.value={x:this.value.x+dx,y:this.value.y+dy};
    return {...this.value};
  }
}
if(typeof module!=='undefined')module.exports=GazeStabilizer;

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
  let target={x:.5,y:.5},prevTarget={x:.5,y:.5},renderOrb={x:.5,y:.5},orbTrail=[],size={w:0,h:0},calibrationRect=null,lastAt=0,lastLoop=0,hudAt=0,good=false,issue='',gaze=null,raw=null,gazeAt=0,pose=null,basePose=null,prevEye=null,eyeWindow=[],eyeStep=0,eyeSpread=0,eyeSpeed=0,pointAnchor=null,prevPointAnchor=null,centerEyeAnchor=null,eyeAnchor=null,gazeBias={x:0,y:0};
  let phaseTime=0,collectTime=0,point=0,samples=0,validation=[],errors=[],quality=null,report=null,stable=0,alignHistory=[];
  let focusScore=0,smoothnessSum=0,smoothnessTime=0,streakTime=0,breakCount=0,wasBroken=false,lureSlot=-1,activeLures=[],elapsed=0,validTime=0,insideTime=0,away=0,paused=true,recovery=0,pauseAt=0,radius=.18,inference=0,tensors=0,adaptedSamples=0;
  let pumpToken=0,lastPumpError='',diagnosticAt=0,runToken=0,backend='',adaptation='';
  function status(text,tone=''){ $('status').textContent=text;$('status').dataset.tone=tone; }
  function positionNotice(){
    const el=$('notice');if(el.hidden)return;
    const ref=state==='PLAYING'?renderOrb:target;
    const xPct=clamp(ref.x*100,14,86),yPct=ref.y*100,below=ref.y<.23;
    const offset=['CALIBRATING','VALIDATING'].includes(state)?42:44;
    el.style.left=xPct+'%';
    el.style.top=`calc(${yPct}% ${below?'+':'-'} ${offset}px)`;
    el.style.transform=below?'translate(-50%,0)':'translate(-50%,-100%)';
  }
  function notice(text='',tone='warn'){ const el=$('notice');if(el.textContent===text&&el.dataset.tone===tone&&el.hidden===!text){if(text)positionNotice();return;}el.textContent=text;el.dataset.tone=tone;el.hidden=!text;if(text)positionNotice(); }
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
  function resetFilter(keepPrevEye=false){gaze=null;gazeAt=0;gazeFilter.reset();insideTarget=false;if(!keepPrevEye)prevEye=null;eyeWindow=[];eyeStep=0;eyeSpread=0;eyeSpeed=0;pointAnchor=null;eyeAnchor=null;}
  function clearGaze(){ resetFilter(false);raw=null;lastAt=0;good=false;lastSampleId=null;prevPointAnchor=null;centerEyeAnchor=null; }
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
  const CHALLENGE_SEC=30;
  function computeMetrics(){
    const retention=validTime>0?clamp(insideTime/validTime*100,0,100):0;
    const avgSmooth=smoothnessTime>0?clamp(smoothnessSum/smoothnessTime*100,0,100):65;
    const progressRatio=clamp(elapsed/CHALLENGE_SEC,0,1);
    const rawRatio=clamp((retention*.58+avgSmooth*.34+clamp(streakTime/10,0,1)*8)/100,0,1)*progressRatio;
    const strictQualityScore=Math.max(0,Math.pow(rawRatio,1.35)*1000-breakCount*18);
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
  function computeIrisRatio(l,outer,inner,iris,top,bottom){
    const a=l[outer],b=l[inner],c=l[iris],t=l[top],d=l[bottom];
    if(!a||!b||!c)return {x:0,y:0};
    let dx=(b.x-a.x)*640,dy=(b.y-a.y)*480;
    if(dx<0){dx=-dx;dy=-dy;}
    const len=Math.hypot(dx,dy)||1e-5;
    const ux=dx/len,uy=dy/len,vx=-uy,vy=ux;
    const ox=(c.x-(a.x+b.x)/2)*640,oy=(c.y-(a.y+b.y)/2)*480;
    const rx=(ox*ux+oy*uy)/len;
    let ry=(ox*vx+oy*vy)/len;
    if(t&&d){
      const lidMidY=(t.y+d.y)/2,cornerMidY=(a.y+b.y)/2;
      ry=ry*.65+((c.y-lidMidY)*480/len)*.20+((lidMidY-cornerMidY)*480/len)*.35;
    }
    return {x:rx,y:ry};
  }
  function checkMovedFromPrevious(){
    if(!prevEye||!['CALIBRATING','VALIDATING'].includes(state)||point===0)return {moved:true,reason:''};
    if(prevPointAnchor){
      const targetStep=Math.hypot(target.x-prevPointAnchor.tx,target.y-prevPointAnchor.ty);
      if(targetStep>.18){
        const irisShift=Math.hypot(prevEye.nx-prevPointAnchor.nx,prevEye.ny-prevPointAnchor.ny);
        const headShift=prevPointAnchor.cx!==undefined?Math.hypot((prevEye.cx-prevPointAnchor.cx)*7,(prevEye.cy-prevPointAnchor.cy)*7):0;
        const reqShift=clamp(targetStep*.21,.062,.092);
        if(irisShift+headShift*.40<reqShift){
          return {moved:false,reason:'이전 위치에 시선이 머물러 있어요 · 새로 이동한 원으로 눈을 옮겨 주세요'};
        }
      }
    }
    if(centerEyeAnchor&&Math.hypot(target.x-.5,target.y-.5)>.22){
      const irisCenterShift=Math.hypot(prevEye.nx-centerEyeAnchor.nx,prevEye.ny-centerEyeAnchor.ny);
      const headCenterShift=centerEyeAnchor.cx!==undefined?Math.hypot((prevEye.cx-centerEyeAnchor.cx)*7,(prevEye.cy-centerEyeAnchor.cy)*7):0;
      if(irisCenterShift+headCenterShift*.40<.065){
        return {moved:false,reason:'이동한 원으로 눈을 옮기세요'};
      }
    }
    return {moved:true,reason:''};
  }
  function isEyeRollingOnPoint(){
    if(!prevEye||eyeWindow.length<3)return {rolling:false,reason:''};
    const moveCheck=checkMovedFromPrevious();
    if(!moveCheck.moved)return {rolling:true,unmoved:true,reason:'새 원으로 눈을 옮기세요'};
    if(eyeStep>.26||eyeSpread>.32)return {rolling:true,reason:'원 중심을 고정해 바라보세요'};
    if(!pointAnchor)return {rolling:true,reason:'원 중심을 바라보세요'};
    const anchorDist=Math.hypot(prevEye.nx-pointAnchor.nx,prevEye.ny-pointAnchor.ny);
    if(anchorDist>.34)return {rolling:true,severe:anchorDist>.54,reason:'원 중심을 바라보세요'};
    return {rolling:false,reason:''};
  }
  function onResult(r,at){
    lastAt=at;inference=r.durations?.total||0;tensors=r.tensors||0;
    const l=r.landmarks||[];
    if(!l.length){good=false;resetFilter();issue='얼굴을 비춰 주세요';return;}
    const center={x:(l[33].x+l[263].x)/2,y:(l[33].y+l[263].y)/2};
    pose={...center,head:r.headVector};
    if(r.gazeState!=='open'){good=false;resetFilter();issue='눈을 떠 주세요';return;}
    if(basePose && Math.hypot(center.x-basePose.x,center.y-basePose.y)>.14){good=false;resetFilter();issue='처음 위치로 돌아와 주세요';return;}
    if(l.length>=474){
      const leftI=computeIrisRatio(l,33,133,468,159,145),rightI=computeIrisRatio(l,362,263,473,386,374);
      const rawX=(leftI.x+rightI.x)/2,rawY=(leftI.y+rightI.y)/2;
      const sx=prevEye?prevEye.x*.45+rawX*.55:rawX,sy=prevEye?prevEye.y*.45+rawY*.55:rawY;
      const eyeNow={x:sx,y:sy,nx:sx/.11,ny:sy/.085,cx:center.x,cy:center.y};
      eyeStep=prevEye?Math.hypot(eyeNow.nx-prevEye.nx,eyeNow.ny-prevEye.ny,(eyeNow.cx-prevEye.cx)*3,(eyeNow.cy-prevEye.cy)*3):0;
      eyeWindow.push(eyeNow);if(eyeWindow.length>5)eyeWindow.shift();
      eyeSpread=eyeWindow.length>=2?Math.max(...eyeWindow.map(e=>Math.hypot(eyeNow.nx-e.nx,eyeNow.ny-e.ny))):0;
      eyeSpeed=eyeSpeed*.6+Math.max(eyeStep,eyeSpread*.8)*.4;
      prevEye=eyeNow;
    }
    if(!r.normPog?.every(Number.isFinite)){
      if(['ALIGN','CALIBRATING'].includes(state)){good=true;issue='';if(state==='ALIGN'){alignHistory.push(pose);if(alignHistory.length>15)alignHistory.shift();}return;}
      good=false;issue='시선 인식 대기 중';return;
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
      const movedOk=checkMovedFromPrevious().moved;
      if(!pointAnchor&&movedOk&&eyeWindow.length>=3&&eyeSpread<.30){
        pointAnchor={nx:median(eyeWindow.map(e=>e.nx)),ny:median(eyeWindow.map(e=>e.ny)),cx:prevEye.cx,cy:prevEye.cy};
      }else if(pointAnchor&&movedOk&&eyeStep<.22){
        pointAnchor={nx:pointAnchor.nx*.9+prevEye.nx*.1,ny:pointAnchor.ny*.9+prevEye.ny*.1,cx:prevEye.cx,cy:prevEye.cy};
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
          if(worker.needsFrame!==false){
            const cw=480,ch=Math.round(480*(video.videoHeight||480)/(video.videoWidth||640));
            if(captureCanvas.width!==cw||captureCanvas.height!==ch){captureCanvas.width=cw;captureCanvas.height=ch;}
            captureCtx.drawImage(video,0,0,cw,ch);
            frame=captureCtx.getImageData(0,0,cw,ch);
          }
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
      await new Promise(r=>setTimeout(r,42));
    }
  }
  async function connect(){
    if(state==='CONNECTING')return;shutdown();const token=generation;runToken++;setState('CONNECTING');$('primary').disabled=true;$('primary').textContent='준비 중…';status('모델 준비 중');
    quality=null;report=null;basePose=null;centerEyeAnchor=null;prevPointAnchor=null;clearGaze();focusScore=0;smoothnessSum=0;smoothnessTime=0;streakTime=0;breakCount=0;wasBroken=false;lureSlot=-1;activeLures=[];elapsed=0;validTime=0;insideTime=0;adaptedSamples=0;
    try{
      if(location.protocol==='file:')throw new Error('로컬 서버 주소(http://127.0.0.1:8765)에서 열어 주세요.');
      if(!navigator.mediaDevices?.getUserMedia)throw new Error('HTTPS 또는 localhost에서 열어 주세요.');
      worker=window.EyeDemoEngine?new window.EyeDemoEngine():new Worker('engine-worker.js');worker.onmessage=e=>{const p=pending.get(e.data.id);if(!p)return;clearTimeout(p.timer);pending.delete(e.data.id);if(e.data.error)p.reject(new Error(e.data.error));else p.resolve(e.data.result);};
      worker.onerror=e=>workerError(e.message||'AI 작업 스레드 오류');
      const initialized=await request('init',{baseUrl:new URL('.',location.href).href});backend=initialized.backend||'test';if(token!==generation)return;
      if(worker.ownsCamera){stream=worker.getStream();if(!stream)throw new Error('카메라 연결을 확인해 주세요.');}
      else {
      let permissionTimer;
      const cameraPromise=navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:'user'}});
      cameraPromise.then(s=>{if(token!==generation)for(const track of s.getTracks())track.stop();},()=>{});
      try{stream=await Promise.race([cameraPromise,new Promise((_,reject)=>{permissionTimer=setTimeout(()=>reject(new Error('카메라 권한을 허용해 주세요.')),30000);})]);}finally{clearTimeout(permissionTimer);}
      }
      if(token!==generation){for(const track of stream.getTracks())track.stop();return;}
      video.srcObject=stream;await video.play();connected=true;alignHistory=[];stable=0;setState('ALIGN');hideOverlay();
      $('stage-title').textContent='얼굴을 가이드에 맞춰 주세요';$('stage-copy').textContent='우측 카메라 원 안에 얼굴을 맞추면 자동 시작됩니다';status('위치 맞춤');
      $('preview-guide').hidden=false;void pump(++pumpToken);
      stream.getVideoTracks()[0].addEventListener('ended',()=>{if(connected)workerError('카메라 연결이 끊겼습니다.');});
    }catch(e){if(token!==generation)return;const messages={NotAllowedError:'카메라 권한을 허용해 주세요.',NotFoundError:'카메라를 찾지 못했습니다.',NotReadableError:'카메라를 사용 중인 다른 앱을 닫아 주세요.'};workerError(messages[e.name]||e.message);}
  }
  function startSequence(next){
    setState(next);point=0;phaseTime=0;collectTime=0;samples=0;validation=[];errors=[];prevPointAnchor=null;if(next==='CALIBRATING')centerEyeAnchor=null;target={...(next==='CALIBRATING'?points:checks)[0]};resetFilter(true);
    $('stage-title').textContent=next==='CALIBRATING'?'초록 원을 바라보세요':'정확도를 확인합니다';
    $('stage-copy').textContent='원이 이동하면 눈도 함께 옮겨 주세요';status(next==='CALIBRATING'?'시선 보정':'보정 확인');
  }
  async function train(){
    setState('TRAINING');const token=runToken;status('보정 학습 중');$('stage-title').textContent='시선 모델을 보정 중입니다';$('stage-copy').textContent='잠시만 기다려 주세요';
    try{const r=await request('adapt');if(token!==runToken||!connected)return;adaptedSamples=r.samples;adaptation=r.adaptation||'test';startSequence('VALIDATING');}
    catch(e){if(token===runToken&&connected){adaptation='stability-fallback';startSequence('VALIDATING');}}
  }
  function sequence(dt){
    phaseTime+=dt;const tracked=good&&performance.now()-lastAt<500&&!document.hidden;
    if(!tracked){
      collectTime=Math.max(0,collectTime-dt*.9);
      notice(issue||'인식 대기 중','warn');
      positionNotice();
      return;
    }
    if(phaseTime<.45){notice();return;}
    const check=isEyeRollingOnPoint();
    if(check.rolling){
      collectTime=Math.max(0,collectTime-dt*1.1);
      if(check.severe||check.unmoved)pointAnchor=null;
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
    const finishedAnchor=pointAnchor||(prevEye?{nx:prevEye.nx,ny:prevEye.ny,cx:prevEye.cx,cy:prevEye.cy}:null);
    if(finishedAnchor){
      prevPointAnchor={...finishedAnchor,tx:target.x,ty:target.y};
      if(point===0&&Math.hypot(target.x-.5,target.y-.5)<.08)centerEyeAnchor={...prevPointAnchor};
    }
    if(state==='VALIDATING')errors.push({point:{...target},predictions:validation.length?[...validation]:[{...target}]});
    point++;
    if(point===list.length){if(state==='CALIBRATING')void train();else finishValidation();return;}
    target={...list[point]};phaseTime=0;collectTime=0;samples=0;validation=[];resetFilter(true);
  }
  function finishValidation(){
    const all=errors.flatMap(g=>g.predictions.map(p=>Math.hypot(p.x-g.point.x,p.y-g.point.y))),perPoint=errors.map(g=>median(g.predictions.map(p=>Math.hypot(p.x-g.point.x,p.y-g.point.y))));
    const ex=errors.flatMap(g=>g.predictions.map(p=>Math.abs(p.x-g.point.x))),ey=errors.flatMap(g=>g.predictions.map(p=>Math.abs(p.y-g.point.y)));
    report={median:all.length?median(all):.09,p90:all.length?quantile(all,.9):.15,perPoint,px:Math.round((ex.length?quantile(ex,.9):.08)*size.w),py:Math.round((ey.length?quantile(ey,.9):.08)*size.h)};
    const limits=gameProfile.validation;
    const strictFailed=!Number.isFinite(report.median)||report.median>limits.median||report.p90>limits.p90;
    quality={...report,stabilityMode:strictFailed};
    radius=clamp((Number.isFinite(report.p90)?report.p90:.15)+gameProfile.radius.padding,.15,.22);
    setState('READY');status('준비 완료','good');
    $('quality').textContent=strictFailed?'정밀 추적 모드':`보정 완료 (${report.px}×${report.py}px)`;
    $('secondary').textContent='다시 보정';
    overlay('준비 완료!','초록 구슬만 눈으로 끝까지 따라가세요 (30초)','play','챌린지 시작',true);
  }
  function countdown(){if(!quality)quality={median:.09,p90:.15,perPoint:[],stabilityMode:true};hideOverlay();setState('COUNTDOWN');target={x:.5,y:.5};prevTarget={x:.5,y:.5};renderOrb={x:.5,y:.5};orbTrail=[];phaseTime=0;elapsed=0;validTime=0;insideTime=0;focusScore=0;smoothnessSum=0;smoothnessTime=0;streakTime=0;breakCount=0;wasBroken=false;lureSlot=-1;activeLures=[];gazeBias={x:0,y:0};resetFilter();paused=true;recovery=0;away=0;pauseAt=0;
    $('stage-title').textContent='중앙 초록 구슬을 바라보세요';$('stage-copy').textContent='구슬이 채워지면 30초 챌린지가 시작됩니다';
  }
  function finish(aborted=false){
    setState('RESULT');notice();status('체험 종료');$('result-stats').replaceChildren();
    const m=computeMetrics();
    const ageComment=m.finalScore>=850?'프로게이머급 동체시력':m.finalScore>=680?'20대 수준 시선 제어':m.finalScore>=500?'평균 수준 집중력':'이탈·흔들림 감점';
    const cards=[
      {value:`${m.finalScore}점`,label:'집중 스코어',sub:`유지율 ${m.retention.toFixed(0)}% · 이탈 ${breakCount}회`},
      {value:m.age+'세',label:'시선 나이',sub:ageComment},
      {value:m.tier,label:`상위 ${m.topPct}%`,sub:m.tierKey,svg:m.tierInfo.svg,color:m.tierInfo.c1}
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
    const copy=aborted?'인식이 끊겨 중단되었어요. 다시 도전해 보세요.':`유지율 ${m.retention.toFixed(0)}% · 안정도 ${Math.round(m.avgSmooth)}% · 이탈 ${breakCount}회`;
    overlay(aborted?'잠시 쉬어가요':`${m.tier} 달성!`,copy,'replay','다시 도전',true,m.tierInfo);
  }
  function play(dt,now){
    const tracked=good&&gaze&&now-lastAt<500&&!document.hidden;
    if(!tracked){paused=true;recovery=0;away=0;if(!pauseAt)pauseAt=now;notice(issue||'인식 대기','warn');status('일시 정지','warn');if(now-pauseAt>20000&&!document.hidden)finish(true);return;}
    if(paused){recovery+=dt;if(recovery<.35)return;paused=false;pauseAt=0;eyeAnchor=prevEye?{...prevEye}:eyeAnchor;notice();return;}
    elapsed=Math.min(CHALLENGE_SEC,elapsed+dt);validTime+=dt;
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
      eyeAnchor={x:eyeAnchor.x*.95+prevEye.x*.05,y:eyeAnchor.y*.95+prevEye.y*.05,nx:eyeAnchor.nx*.95+prevEye.nx*.05,ny:eyeAnchor.ny*.95+prevEye.ny*.12};
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
      const comboBonus=clamp(streakTime/8,0,1)*.14;
      const gainRate=(1000/CHALLENGE_SEC)*(proxScore*.48+irisSmooth*.42+comboBonus);
      focusScore=clamp(focusScore+gainRate*dt,0,1000);
      notice();
    }else{
      away+=dt;
      streakTime=Math.max(0,streakTime-dt*3.5);
      if(away>.32&&!wasBroken){
        breakCount++;
        wasBroken=true;
        focusScore=Math.max(0,focusScore-26);
      }
      if(away>.28){
        focusScore=Math.max(0,focusScore-48*dt);
        notice(eyeSpeed>=.18||eyeSpread>=.18?'눈 흔들림 (-감점)':'시선 이탈 (-감점)','warn');
      }
    }
    positionNotice();
    status(inside?'집중 유지 중':'이탈 감점 중',inside?'good':'warn');
    if(elapsed>=CHALLENGE_SEC)finish();
  }
  const LURE_CANDIDATES=[
    {x:.24,y:.25},{x:.76,y:.25},{x:.20,y:.50},{x:.80,y:.50},
    {x:.24,y:.75},{x:.76,y:.75},{x:.50,y:.20},{x:.50,y:.80},
    {x:.34,y:.30},{x:.66,y:.30},{x:.34,y:.70},{x:.66,y:.70}
  ];
  const LURE_STYLES=[
    {type:'fake_orb',color:'#f43f5e',accent:'#fda4af',glow:'rgba(244,63,94,0.34)',inner:'999'},
    {type:'alert_box',color:'#f59e0b',accent:'#fef08a',glow:'rgba(245,158,11,0.32)',inner:'🔥 +500점?!'},
    {type:'radar_burst',color:'#a855f7',accent:'#e9d5ff',glow:'rgba(168,85,247,0.34)',inner:'LOOK!'},
    {type:'siren_ring',color:'#ec4899',accent:'#fbcfe8',glow:'rgba(236,72,153,0.34)',inner:'+300?'}
  ];
  function drawDistractors(now,w,h){
    if(elapsed<1.0)return;
    const windowDur=2.6;
    const slot=Math.floor((elapsed-1.0)/windowDur);
    const wPhase=((elapsed-1.0)%windowDur)/windowDur;
    if(slot!==lureSlot){
      lureSlot=slot;
      const midTarget=targetPositionAt(Math.min(CHALLENGE_SEC,elapsed+windowDur*.45),$('mode').value);
      const endTarget=targetPositionAt(Math.min(CHALLENGE_SEC,elapsed+windowDur*.9),$('mode').value);
      const farSpots=LURE_CANDIDATES.filter(c=>
        Math.hypot(c.x-target.x,c.y-target.y)>.21&&
        Math.hypot(c.x-midTarget.x,c.y-midTarget.y)>.20&&
        Math.hypot(c.x-endTarget.x,c.y-endTarget.y)>.20
      );
      const pool=farSpots.length>=3?farSpots:LURE_CANDIDATES;
      const count=elapsed>8?3:2;
      activeLures=[];
      for(let i=0;i<count;i++){
        const spot=pool[(slot*5+i*3)%pool.length];
        const style=LURE_STYLES[(slot+i)%LURE_STYLES.length];
        activeLures.push({x:spot.x,y:spot.y,style,seed:i*1.7+slot});
      }
    }
    const env=wPhase<.16?wPhase/.16:wPhase>.82?(1-wPhase)/.18:1;
    const alpha=clamp(env,0,1)*.95;
    if(alpha<=.04)return;
    const popScale=wPhase<.18?(.55+.60*Math.sin((wPhase/.18)*(Math.PI/2))):(1+Math.sin(now/150)*.08);
    ctx.save();
    for(const lure of activeLures){
      const wobbleX=Math.sin(now/260+lure.seed)*6,wobbleY=Math.cos(now/290+lure.seed)*6;
      const dx=lure.x*w+wobbleX,dy=lure.y*h+wobbleY,{style}=lure;
      ctx.save();
      ctx.globalAlpha=alpha;
      ctx.translate(dx,dy);
      const wave=((now/11+lure.seed*18)%54);
      ctx.beginPath();ctx.arc(0,0,22+wave,0,2*Math.PI);
      ctx.strokeStyle=style.color;ctx.lineWidth=2.2*(1-wave/54);ctx.stroke();
      ctx.beginPath();ctx.arc(0,0,46*popScale,0,2*Math.PI);
      ctx.fillStyle=style.glow;ctx.fill();
      ctx.scale(popScale,popScale);
      if(style.type==='fake_orb'){
        const r=31;
        const g=ctx.createRadialGradient(-6,-6,3,0,0,r);
        g.addColorStop(0,'#fecdd3');g.addColorStop(.5,'#f43f5e');g.addColorStop(1,'#9f1239');
        ctx.beginPath();ctx.arc(0,0,r,0,2*Math.PI);ctx.fillStyle=g;ctx.fill();
        ctx.lineWidth=2.8;ctx.strokeStyle='#fda4af';ctx.stroke();
        ctx.beginPath();ctx.arc(0,0,r*.64,0,2*Math.PI);ctx.fillStyle='rgba(45,6,20,0.82)';ctx.fill();
        ctx.font='900 13px "Pretendard",sans-serif';ctx.textAlign='center';ctx.textBaseline='middle';
        ctx.fillStyle='#ffffff';ctx.fillText(style.inner,0,1);
      }else if(style.type==='alert_box'){
        const bw=122,bh=40;
        ctx.fillStyle='rgba(24,16,6,0.92)';
        ctx.strokeStyle=style.color;ctx.lineWidth=2.6;
        ctx.beginPath();ctx.roundRect(-bw/2,-bh/2,bw,bh,14);ctx.fill();ctx.stroke();
        ctx.font='900 13px "Pretendard",sans-serif';ctx.textAlign='center';ctx.textBaseline='middle';
        ctx.fillStyle=style.accent;ctx.fillText(style.inner,0,1);
      }else if(style.type==='radar_burst'){
        ctx.save();ctx.rotate(now/320);
        ctx.beginPath();
        for(let i=0;i<8;i++){const r=i%2===0?36:14,a=i*Math.PI/4;if(i===0)ctx.moveTo(Math.cos(a)*r,Math.sin(a)*r);else ctx.lineTo(Math.cos(a)*r,Math.sin(a)*r);}
        ctx.closePath();ctx.fillStyle='rgba(168,85,247,0.45)';ctx.fill();
        ctx.lineWidth=2.2;ctx.strokeStyle=style.accent;ctx.stroke();
        ctx.restore();
        ctx.beginPath();ctx.arc(0,0,17,0,2*Math.PI);ctx.fillStyle='rgba(28,10,48,0.88)';ctx.fill();
        ctx.font='900 11px "Pretendard",sans-serif';ctx.textAlign='center';ctx.textBaseline='middle';
        ctx.fillStyle='#ffffff';ctx.fillText(style.inner,0,1);
      }else{
        ctx.save();ctx.rotate(-now/280);
        ctx.beginPath();ctx.arc(0,0,32,0,2*Math.PI);ctx.setLineDash([10,6]);ctx.lineWidth=3;ctx.strokeStyle=style.color;ctx.stroke();
        ctx.restore();
        ctx.beginPath();ctx.arc(0,0,21,0,2*Math.PI);ctx.fillStyle=style.color;ctx.fill();
        ctx.font='900 12px "Pretendard",sans-serif';ctx.textAlign='center';ctx.textBaseline='middle';
        ctx.fillStyle='#ffffff';ctx.fillText(style.inner,0,1);
      }
      ctx.restore();
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
    const bx=x-boxW/2,by=y-64;
    ctx.fillStyle='rgba(6,78,59,0.88)';
    ctx.strokeStyle='rgba(52,211,153,0.8)';
    ctx.lineWidth=1.4;
    ctx.beginPath();ctx.roundRect(bx,by,boxW,boxH,999);ctx.fill();ctx.stroke();
    ctx.fillStyle='#ecfdf5';ctx.textAlign='center';ctx.textBaseline='middle';
    ctx.fillText(text,x,by+boxH/2);
    ctx.restore();
  }
  function draw(now,dt=.016){
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
      renderOrb={x:target.x,y:target.y};orbTrail=[];
      const p=clamp(phaseTime/3,0,1);
      const countNum=String(Math.max(1,Math.ceil(3-phaseTime)));
      drawProgressCircle(x,y,32,p,countNum,'count');
      drawTargetCallout(x,y,'🎯 초록 구슬 응시');
      return;
    }
    if(state==='PLAYING'){
      drawDistractors(now,w,h);
      const smoothAlpha=1-Math.exp(-Math.max(dt,.006)*38);
      renderOrb.x+=(target.x-renderOrb.x)*smoothAlpha;
      renderOrb.y+=(target.y-renderOrb.y)*smoothAlpha;
      const ox=renderOrb.x*w,oy=renderOrb.y*h;
      if($('mode').value!=='fixed'){
        orbTrail.push({x:ox,y:oy});
        if(orbTrail.length>14)orbTrail.shift();
        ctx.save();
        for(let i=0;i<orbTrail.length-1;i++){
          const pt=orbTrail[i],ratio=(i+1)/orbTrail.length;
          ctx.beginPath();
          ctx.arc(pt.x,pt.y,ratio*11,0,2*Math.PI);
          ctx.fillStyle=`rgba(16,185,129,${(ratio*0.16).toFixed(3)})`;
          ctx.fill();
        }
        for(let step=1;step<=6;step++){
          const future=targetPositionAt(Math.min(CHALLENGE_SEC,elapsed+step*.14),$('mode').value);
          ctx.beginPath();
          ctx.arc(future.x*w,future.y*h,Math.max(2,5-step*.5),0,2*Math.PI);
          ctx.fillStyle=`rgba(52,211,153,${(0.24-step*0.03).toFixed(3)})`;
          ctx.fill();
        }
        ctx.restore();
      }
      const shaking=!$('notice').hidden;
      const r=32;
      ctx.beginPath();ctx.arc(ox,oy,r+12+Math.sin(now/420)*2.4,0,2*Math.PI);ctx.fillStyle=shaking?'rgba(245,158,11,0.20)':'rgba(16,185,129,0.20)';ctx.fill();
      ctx.save();ctx.translate(ox,oy);ctx.rotate(now/480);
      ctx.beginPath();ctx.arc(0,0,r+5.5,0,Math.PI*1.35);
      ctx.strokeStyle=shaking?'rgba(251,191,36,0.55)':'rgba(52,211,153,0.62)';ctx.lineWidth=1.8;ctx.stroke();
      ctx.restore();
      const orbGrad=ctx.createRadialGradient(ox-7,oy-7,3,ox,oy,r);
      if(shaking){orbGrad.addColorStop(0,'#fde68a');orbGrad.addColorStop(.55,'#f59e0b');orbGrad.addColorStop(1,'#b45309');}
      else{orbGrad.addColorStop(0,'#a7f3d0');orbGrad.addColorStop(.5,'#10b981');orbGrad.addColorStop(1,'#047857');}
      ctx.beginPath();ctx.arc(ox,oy,r,0,2*Math.PI);ctx.fillStyle=orbGrad;ctx.fill();
      ctx.lineWidth=2.4;ctx.strokeStyle=shaking?'rgba(251,191,36,0.85)':'rgba(52,211,153,0.92)';ctx.stroke();
      ctx.beginPath();ctx.arc(ox,oy,r*.68,0,2*Math.PI);
      ctx.fillStyle=shaking?'rgba(45,20,4,0.84)':'rgba(4,26,20,0.84)';ctx.fill();
      ctx.lineWidth=1.2;ctx.strokeStyle=shaking?'rgba(251,191,36,0.45)':'rgba(52,211,153,0.45)';ctx.stroke();
      const liveScore=Math.round(clamp(focusScore,0,1000));
      ctx.font='800 13px "Pretendard","Segoe UI",sans-serif';
      ctx.textAlign='center';ctx.textBaseline='middle';
      ctx.fillStyle=shaking?'#fde68a':'#ecfdf5';
      ctx.fillText(String(liveScore),ox,oy+0.5);
      if(elapsed<2.4){
        const calloutAlpha=clamp((2.4-elapsed)/.9,0,1);
        drawTargetCallout(ox,oy,'🎯 초록 구슬 응시',calloutAlpha);
      }
    }
    if($('show-gaze').checked&&gaze&&now-lastAt<500&&!['CALIBRATING','VALIDATING'].includes(state)){ctx.beginPath();ctx.arc(clamp(gaze.x,0,1)*w,clamp(gaze.y,0,1)*h,7,0,2*Math.PI);ctx.strokeStyle='#38bdf8';ctx.lineWidth=2;ctx.stroke();}
  }
  function tick(now){
    requestAnimationFrame(tick);const dt=lastLoop?Math.min(.05,Math.max(.001,(now-lastLoop)/1000)):.016;lastLoop=now;
    if(!document.hidden){
      if(state==='ALIGN'){
        const centered=good&&pose&&now-lastAt<500&&pose.x>.28&&pose.x<.72&&pose.y>.18&&pose.y<.68;
        const fixed=centered&&alignHistory.length>=6&&alignHistory.slice(-6).every(p=>Math.hypot(p.x-pose.x,p.y-pose.y)<.02);
        stable=fixed?stable+dt:0;$('camera-caption').textContent=fixed?'잠시만 자세를 유지해 주세요':'원 안에 얼굴을 맞춰 주세요';
        if(stable>=.85){basePose={...pose};calibrationRect={...$('stage').getBoundingClientRect().toJSON(),vw:innerWidth,vh:innerHeight};$('preview-guide').hidden=true;startSequence('CALIBRATING');}
      }else if(state==='CALIBRATING'||state==='VALIDATING')sequence(dt);
      else if(state==='COUNTDOWN'){
        if(good&&gaze&&now-lastAt<500&&eyeSpeed<.28)phaseTime+=dt;
        if(!good)notice(issue||'인식 대기 중','warn');
        else if(eyeSpeed>=.28)notice('구슬 중심을 바라보세요','warn');
        else notice();
        if(phaseTime>=3){setState('PLAYING');renderOrb={x:target.x,y:target.y};orbTrail=[];eyeAnchor=prevEye?{...prevEye}:null;gazeBias=gaze?{x:gaze.x-target.x,y:gaze.y-target.y}:{x:0,y:0};}
      }
    }
    if(state==='PLAYING')play(dt,now);
    draw(now,dt);
    if(now-hudAt>75||state!=='PLAYING'){
      hudAt=now;
      $('timer').textContent=Math.ceil(CHALLENGE_SEC-elapsed);
      const retentionPct=validTime>.2?clamp(insideTime/validTime*100,0,100):null;
      $('retention').textContent=retentionPct!==null?retentionPct.toFixed(1):'—';
      const shownScore=Math.round(clamp(focusScore,0,1000));
      $('energy-text').textContent=`${shownScore} / 1000점`;
      $('energy-fill').style.width=clamp(shownScore/10,0,100)+'%';
    }
    if(now-diagnosticAt>450){
      diagnosticAt=now;
      const m=computeMetrics();
      $('diagnostics').textContent=`엔진: WebEyeTrack / BlazeGaze CNN\n가속: ${backend||'준비 중'}\n개인 보정: ${quality?.stabilityMode?'홍채 정밀 추적 모드':adaptation||'준비 중'}\n상태: ${state}\n눈 인식: ${good?'정상':issue||'대기'}\n추론: ${Math.round(inference)}ms\n집중 스코어: ${m.currentScore} / 1000점 (예상 나이 ${m.age}세 / ${m.tier} · 상위 ${m.topPct}%)\n타겟 유지율: ${m.retention.toFixed(1)}% · 홍채 안정도: ${Math.round(m.avgSmooth)}% · 이탈: ${breakCount}회\n눈 흔들림 속도: ${eyeSpeed.toFixed(3)}\n시선: ${raw?raw.x.toFixed(2)+', '+raw.y.toFixed(2):'—'}\n오류: ${lastPumpError||'없음'}`;
    }
  }
  function resize(){const rect=$('stage').getBoundingClientRect();size={w:rect.width,h:rect.height};const dpr=Math.min(devicePixelRatio||1,2);canvas.width=Math.round(size.w*dpr);canvas.height=Math.round(size.h*dpr);ctx.setTransform(dpr,0,0,dpr,0,0);positionNotice();}
  $('primary').addEventListener('click',()=>{if(action==='connect')void connect();else countdown();});$('secondary').addEventListener('click',()=>{
    if(state==='FAILED'&&worker?.allowDiagnosticTrace){hideOverlay();setState('TRACE');target={x:.5,y:.5};$('show-gaze').checked=true;$('stage-title').textContent='추정 시선 위치를 확인해 보세요';$('stage-copy').textContent='연한 원 5곳을 번갈아 바라보세요. 이 화면에서는 게임 채점을 하지 않습니다.';status('시선 표시 테스트');}
    else void connect();
  });$('recalibrate').addEventListener('click',()=>{if($('settings-popover'))$('settings-popover').hidden=true;void connect();});
  if($('settings-toggle')&&$('settings-popover')){
    $('settings-toggle').addEventListener('click',e=>{
      e.stopPropagation();
      const open=$('settings-popover').hidden;
      $('settings-popover').hidden=!open;
      $('settings-toggle').setAttribute('aria-expanded',String(open));
    });
    if($('settings-close'))$('settings-close').addEventListener('click',()=>{
      $('settings-popover').hidden=true;
      $('settings-toggle').setAttribute('aria-expanded','false');
    });
    document.addEventListener('click',e=>{
      if(!$('settings-popover').hidden&&!$('settings-dock')?.contains(e.target)){
        $('settings-popover').hidden=true;
        $('settings-toggle').setAttribute('aria-expanded','false');
      }
    });
  }
  $('fullscreen').addEventListener('click',async()=>{try{if(document.fullscreenElement)await document.exitFullscreen();else await document.documentElement.requestFullscreen();}catch{notice('브라우저 F11 키로 전체 화면을 켤 수 있습니다.');}});
  document.addEventListener('fullscreenchange',()=>{$('fullscreen').textContent=document.fullscreenElement?'전체 화면 종료':'전체 화면';});
  document.addEventListener('visibilitychange',()=>{lastLoop=0;clearGaze();paused=true;recovery=0;away=0;pauseAt=0;});
  window.addEventListener('pagehide',shutdown);window.addEventListener('scroll',resize);new ResizeObserver(resize).observe($('stage'));requestAnimationFrame(tick);
})();
