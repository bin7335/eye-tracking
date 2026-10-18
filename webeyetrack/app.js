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
  let focusScore=0,smoothnessSum=0,smoothnessTime=0,streakTime=0,elapsed=0,validTime=0,insideTime=0,away=0,paused=true,recovery=0,pauseAt=0,radius=.18,inference=0,tensors=0,adaptedSamples=0;
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
  function overlay(title,copy,next,label,recalibrate=false){
    $('overlay').hidden=false;$('overlay-kicker').textContent='WEBEYETRACK · CNN';$('overlay-title').textContent=title;$('overlay-copy').textContent=copy;
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
      const p=tSec*.68;
      return {x:.5+ease*(.27*Math.sin(p)),y:.5+ease*(.17*Math.sin(p*2))};
    }
    const speed=tSec<20?.48:tSec<42?.58:.66,p=tSec*speed;
    return {x:.5+ease*(.23*Math.sin(p)+.05*Math.sin(p*1.9)),y:.5+ease*(.15*Math.sin(p*.72+.35)+.04*Math.cos(p*1.5))};
  }
  function computeMetrics(){
    const retention=validTime>0?clamp(insideTime/validTime*100,0,100):0;
    const avgSmooth=smoothnessTime>0?clamp(smoothnessSum/smoothnessTime*100,0,100):85;
    const progressRatio=clamp(elapsed/60,0,1);
    const liveQuality=clamp(retention*.58+avgSmooth*.32+clamp(streakTime/10,0,1)*10,0,100);
    const currentScore=Math.round(clamp(focusScore,0,100));
    const finalScore=Math.round(clamp(currentScore*.65+(liveQuality*progressRatio)*.35,0,100));
    let age=30;
    if(finalScore>=95)age=18;
    else if(finalScore>=88)age=Math.round(19+(95-finalScore)*.7);
    else if(finalScore>=78)age=Math.round(24+(88-finalScore)*.7);
    else if(finalScore>=65)age=Math.round(31+(78-finalScore)*.75);
    else if(finalScore>=50)age=Math.round(41+(65-finalScore)*.75);
    else age=Math.round(clamp(52+(50-finalScore)*.35,52,68));
    const percentile=clamp(Math.round(1+Math.pow(finalScore/100,1.25)*98),1,99);
    const topPct=Math.max(1,100-percentile);
    const tier=percentile>=95?'마스터':percentile>=85?'다이아':percentile>=72?'플래티넘':percentile>=55?'골드':percentile>=35?'실버':'브론즈';
    return {retention,avgSmooth,currentScore,finalScore,age,percentile,topPct,tier};
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
    if(!prevEye||eyeWindow.length<4)return {rolling:true,reason:'원 중심에 시선을 맞춰 주세요'};
    if(eyeStep>.17||eyeSpread>.21)return {rolling:true,reason:'눈이 움직였어요 · 원 중심을 고정해 바라보세요'};
    if(pointAnchor){
      const anchorDist=Math.hypot(prevEye.nx-pointAnchor.nx,prevEye.ny-pointAnchor.ny);
      if(anchorDist>.23)return {rolling:true,severe:anchorDist>.34,reason:'눈이 돌아갔어요 · 원 중심을 바라봐 주세요'};
    }
    if(state==='CALIBRATING'&&point>0&&centerEyeAnchor){
      const targetOffset=Math.hypot(target.x-.5,target.y-.5);
      const eyeFromCenter=Math.hypot(prevEye.nx-centerEyeAnchor.nx,prevEye.ny-centerEyeAnchor.ny);
      if(targetOffset>.28&&eyeFromCenter<.14){
        return {rolling:true,reason:'시선을 초록 원 위치로 옮겨 바라봐 주세요'};
      }
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
      const eyeNow={x:rawX,y:rawY,nx:rawX/.018,ny:rawY/.012,cx:center.x,cy:center.y};
      eyeStep=prevEye?Math.hypot(eyeNow.nx-prevEye.nx,eyeNow.ny-prevEye.ny,(eyeNow.cx-prevEye.cx)*8,(eyeNow.cy-prevEye.cy)*8):0;
      eyeWindow.push(eyeNow);if(eyeWindow.length>6)eyeWindow.shift();
      eyeSpread=eyeWindow.length>=2?Math.max(...eyeWindow.map(e=>Math.hypot(eyeNow.nx-e.nx,eyeNow.ny-e.ny))):0;
      eyeSpeed=eyeSpeed*.55+Math.max(eyeStep*1.35,eyeSpread)*.45;
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
      const eyeNow={x:p.x,y:p.y,nx:(p.x-.5)*2.2,ny:(p.y-.5)*2.2,cx:center.x,cy:center.y};
      eyeStep=prevEye?Math.hypot(eyeNow.nx-prevEye.nx,eyeNow.ny-prevEye.ny):0;
      eyeWindow.push(eyeNow);if(eyeWindow.length>6)eyeWindow.shift();
      eyeSpread=eyeWindow.length>=2?Math.max(...eyeWindow.map(e=>Math.hypot(eyeNow.nx-e.nx,eyeNow.ny-e.ny))):0;
      eyeSpeed=eyeSpeed*.55+Math.max(eyeStep*1.35,eyeSpread)*.45;
      prevEye=eyeNow;
    }
    if(['CALIBRATING','VALIDATING','COUNTDOWN'].includes(state)&&phaseTime>=1){
      if(!pointAnchor&&eyeWindow.length>=5&&eyeSpread<.19&&eyeStep<.15){
        pointAnchor={nx:median(eyeWindow.map(e=>e.nx)),ny:median(eyeWindow.map(e=>e.ny))};
      }
    }
    raw=p;
    gaze=gazeFilter.update(p,r.sampleAt??at);gazeAt=at;
    if(state==='VALIDATING'&&phaseTime>1&&!isEyeRollingOnPoint().rolling)validation.push({...gaze});
  }
  async function pump(token){
    while(connected&&token===pumpToken){
      if(!document.hidden&&!busy&&video.readyState>=2){
        busy=true;const capturePoint=point,captureState=state;
        try{
          let frame;
          if(worker.needsFrame!==false){captureCanvas.width=640;captureCanvas.height=Math.round(640*(video.videoHeight||480)/(video.videoWidth||640));captureCtx.drawImage(video,0,0,captureCanvas.width,captureCanvas.height);frame=captureCtx.getImageData(0,0,captureCanvas.width,captureCanvas.height);}
          const rect=$('stage').getBoundingClientRect();
          const canCapture=state==='CALIBRATING'&&phaseTime>1&&!isEyeRollingOnPoint().rolling;
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
    quality=null;report=null;basePose=null;centerEyeAnchor=null;clearGaze();focusScore=0;smoothnessSum=0;smoothnessTime=0;streakTime=0;elapsed=0;validTime=0;insideTime=0;adaptedSamples=0;
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
      collectTime=Math.max(0,collectTime-dt*1.2);
      notice(issue||'눈 인식을 기다리고 있어요','warn');
      positionNotice();
      return;
    }
    if(phaseTime<1){notice();return;}
    const check=isEyeRollingOnPoint();
    if(check.rolling){
      collectTime=Math.max(0,collectTime-dt*1.8);
      if(check.severe){
        pointAnchor=null;
        validation=[];
        collectTime=0;
      }
      notice(check.reason,'warn');
      positionNotice();
      return;
    }
    collectTime+=dt;
    notice();
    positionNotice();
    const list=state==='CALIBRATING'?points:checks;
    if(collectTime<1.4||(state==='CALIBRATING'?samples<2:validation.length<5))return;
    if(state==='CALIBRATING'&&point===0&&pointAnchor){
      centerEyeAnchor={...pointAnchor};
    }
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
    radius=clamp((Number.isFinite(report.p90)?report.p90:.15)+gameProfile.radius.padding,.16,.25);
    setState('READY');status('체험 준비 완료','good');
    $('quality').textContent=strictFailed?'홍채 부드러운 추적 모드 적용':`보정 완료 · 90% 오차 범위 ${report.px}px / ${report.py}px`;
    $('secondary').textContent='다시 보정';
    overlay('준비됐어요.','천천히 움직이는 초록 구슬을 눈(홍채)으로 부드럽게 따라가 보세요.\n흔들림 없이 따라갈수록 집중 스코어와 분위 레벨이 올라갑니다.','play','60초 챌린지 시작',true);
  }
  function countdown(){if(!quality)quality={median:.09,p90:.15,perPoint:[],stabilityMode:true};hideOverlay();setState('COUNTDOWN');target={x:.5,y:.5};prevTarget={x:.5,y:.5};phaseTime=0;elapsed=0;validTime=0;insideTime=0;focusScore=0;smoothnessSum=0;smoothnessTime=0;streakTime=0;gazeBias={x:0,y:0};resetFilter();paused=true;recovery=0;away=0;pauseAt=0;
    $('stage-title').textContent='가운데 구슬을 바라보세요';$('stage-copy').textContent='구슬 내부가 모두 채워지면 움직이는 구슬 추적이 시작됩니다.';
  }
  function finish(aborted=false){
    setState('RESULT');notice();status('체험 종료');$('result-stats').replaceChildren();
    const m=computeMetrics();
    const cards=[
      [m.finalScore+'점','최종 집중력 스코어',`타겟 유지율 ${m.retention.toFixed(1)}%`],
      [m.age+'세','추정 시선 신체 나이',m.finalScore>=85?'20대 초반급 시선 제어':'안정적인 홍채 추적 반응'],
      [`${m.percentile}분위`,`1-100% 분위 레벨 (${m.tier})`,`전체 상위 ${m.topPct}% 수준`]
    ];
    for(const [value,label,sub]of cards){
      const div=document.createElement('div'),v=document.createElement('strong'),l=document.createElement('span'),s=document.createElement('small');
      v.textContent=value;l.textContent=label;s.textContent=sub;div.append(v,l,s);$('result-stats').append(div);
    }
    const copy=aborted?'인식이 오래 끊겨 체험을 멈췄어요.\n위치를 맞추고 다시 도전해 보세요.':`타겟 유지율 ${m.retention.toFixed(1)}% · 홍채 흔들림 안정도 ${Math.round(m.avgSmooth)}%\n움직이는 타겟을 눈동자로 부드럽게 따라간 종합 결과입니다.`;
    overlay(aborted?'잠시 쉬어도 괜찮아요':m.finalScore>=85?'놀라운 홍채 집중력이에요!':elapsed>=48?'60초, 시선 추적을 완주했어요':'좋은 도전이었어요',copy,'replay','다시 도전',true);
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
    if(eyeSpeed<.20){
      gazeBias={x:gazeBias.x*.94+(gaze.x-target.x)*.06,y:gazeBias.y*.94+(gaze.y-target.y)*.06};
    }
    const adjGaze={x:gaze.x-gazeBias.x*.65,y:gaze.y-gazeBias.y*.65};
    const dist=Math.hypot(adjGaze.x-target.x,adjGaze.y-target.y);
    if(!eyeAnchor&&prevEye)eyeAnchor={...prevEye};
    if(targetMoving&&prevEye&&eyeSpeed<.22){
      eyeAnchor={x:eyeAnchor.x*.88+prevEye.x*.12,y:eyeAnchor.y*.88+prevEye.y*.12,nx:eyeAnchor.nx*.88+prevEye.nx*.12,ny:eyeAnchor.ny*.88+prevEye.ny*.12};
    }else if(!targetMoving&&prevEye&&eyeSpeed<.18){
      eyeAnchor={x:eyeAnchor.x*.96+prevEye.x*.04,y:eyeAnchor.y*.96+prevEye.y*.04,nx:eyeAnchor.nx*.96+prevEye.nx*.04,ny:eyeAnchor.ny*.96+prevEye.ny*.04};
    }
    const eyeDrift=eyeAnchor&&prevEye?Math.hypot(prevEye.nx-eyeAnchor.nx,prevEye.ny-eyeAnchor.ny):0;
    const irisSmooth=clamp(1-Math.max(0,eyeSpeed-.05)/.22,0,1);
    smoothnessSum+=irisSmooth*dt;smoothnessTime+=dt;
    const eyeFollowing=eyeSpeed<.22&&eyeSpread<.23&&eyeDrift<.30;
    const coordInside=dist<=radius*1.15+(insideTarget?gameProfile.boundarySlack:0);
    const inside=(coordInside&&eyeSpeed<.24&&eyeSpread<.24)||(eyeFollowing&&(quality?.stabilityMode||dist<=radius*1.45));
    insideTarget=inside;
    if(inside){
      const retentionWeight=coordInside&&eyeSpeed<.16?1:eyeSpeed<.22?.92:.82;
      insideTime+=dt*retentionWeight;
      away=0;
      streakTime+=dt;
      const proxScore=clamp(1-dist/(radius*1.5),.45,1);
      const comboBonus=clamp(streakTime/10,0,1)*.18;
      const gainRate=(100/60)*(proxScore*.42+irisSmooth*.40+.18+comboBonus);
      focusScore=clamp(focusScore+gainRate*dt,0,100);
      notice();
    }else{
      away+=dt;
      streakTime=Math.max(0,streakTime-dt*2.4);
      if(away>.55){
        focusScore=Math.max(0,focusScore-1.8*dt);
        notice(eyeSpeed>=.22||eyeSpread>=.23?'눈동자 흔들림 · 구슬을 부드럽게 따라가세요':'초록 구슬을 바라봐 주세요','warn');
      }
    }
    positionNotice();
    status(inside?'홍채 추적 중':'시선 흔들림 감지',inside?'good':'warn');
    if(elapsed>=60)finish();
  }
  function drawProgressCircle(x,y,r,progress,labelText,subText=''){
    const p=clamp(progress,0,1);
    ctx.beginPath();ctx.arc(x,y,r+10+Math.sin(performance.now()/500)*2,0,2*Math.PI);ctx.fillStyle='#16836d12';ctx.fill();
    ctx.beginPath();ctx.arc(x,y,r,0,2*Math.PI);ctx.fillStyle='#e6f3ec';ctx.fill();
    ctx.lineWidth=2;ctx.strokeStyle='#16836d40';ctx.stroke();
    if(p>0){
      ctx.save();
      ctx.beginPath();ctx.arc(x,y,r-1.5,0,2*Math.PI);ctx.clip();
      const fillTop=y+r-(2*r*p);
      ctx.fillStyle='#16836d';
      ctx.fillRect(x-r,fillTop,r*2,r*2);
      ctx.beginPath();ctx.arc(x,y,(r-1.5)*p,0,2*Math.PI);
      ctx.fillStyle='rgba(22,131,109,0.55)';ctx.fill();
      ctx.restore();
      ctx.beginPath();ctx.arc(x,y,r,-Math.PI/2,-Math.PI/2+p*2*Math.PI);
      ctx.strokeStyle='#0f6a57';ctx.lineWidth=3.5;ctx.stroke();
    }
    ctx.beginPath();ctx.arc(x,y,4,0,2*Math.PI);
    ctx.fillStyle=p>.52?'#ffffff':'#16836d';ctx.fill();
    if(labelText){
      ctx.font='700 12px "Pretendard","Segoe UI",sans-serif';
      ctx.textAlign='center';ctx.textBaseline='middle';
      ctx.fillStyle=p>.58?'#ffffff':'#134e41';
      ctx.fillText(labelText,x,y+(subText?-1:15));
    }
  }
  function draw(now){
    const {w,h}=size;ctx.clearRect(0,0,w,h);if(!$('overlay').hidden||['ALIGN','IDLE','CONNECTING'].includes(state))return;
    const x=target.x*w,y=target.y*h;
    if(state==='TRACE')for(const p of checks){ctx.beginPath();ctx.arc(p.x*w,p.y*h,10,0,2*Math.PI);ctx.strokeStyle='#16836d55';ctx.lineWidth=2;ctx.stroke();}
    if(['CALIBRATING','VALIDATING'].includes(state)){
      const list=state==='CALIBRATING'?points:checks;
      const p=clamp(collectTime/1.4,0,1);
      drawProgressCircle(x,y,28,p,`${point+1}/${list.length}`);
      return;
    }
    if(state==='COUNTDOWN'){
      const p=clamp(phaseTime/3,0,1);
      const countNum=String(Math.max(1,Math.ceil(3-phaseTime)));
      drawProgressCircle(x,y,32,p,countNum,'count');
      return;
    }
    if(state==='PLAYING'){
      if($('mode').value!=='fixed'){
        ctx.save();
        for(let step=1;step<=7;step++){
          const future=targetPositionAt(Math.min(60,elapsed+step*.16),$('mode').value);
          ctx.beginPath();
          ctx.arc(future.x*w,future.y*h,Math.max(2,5.5-step*.55),0,2*Math.PI);
          ctx.fillStyle=`rgba(22,131,109,${(0.22-step*0.025).toFixed(3)})`;
          ctx.fill();
        }
        ctx.restore();
      }
      const shaking=!$('notice').hidden;
      const r=24;
      ctx.beginPath();ctx.arc(x,y,r+8+Math.sin(now/600)*1.8,0,2*Math.PI);ctx.fillStyle=shaking?'rgba(209,132,40,0.14)':'rgba(22,131,109,0.12)';ctx.fill();
      ctx.beginPath();ctx.arc(x,y,r,0,2*Math.PI);ctx.fillStyle=shaking?'#b87324':'#16836d';ctx.fill();
      ctx.beginPath();ctx.arc(x-4,y-5,r*.22,0,2*Math.PI);ctx.fillStyle='#ffffff80';ctx.fill();
      ctx.beginPath();ctx.arc(x,y,3.5,0,2*Math.PI);ctx.fillStyle='#ffffff';ctx.fill();
    }
    if($('show-gaze').checked&&gaze&&now-lastAt<500&&!['CALIBRATING','VALIDATING'].includes(state)){ctx.beginPath();ctx.arc(clamp(gaze.x,0,1)*w,clamp(gaze.y,0,1)*h,7,0,2*Math.PI);ctx.strokeStyle='#8a662b';ctx.lineWidth=2;ctx.stroke();}
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
    const shownScore=Math.round(clamp(focusScore,0,100));
    $('energy-text').textContent=shownScore+'점';
    $('energy-fill').style.width=shownScore+'%';
    if(now-diagnosticAt>400){
      diagnosticAt=now;
      const m=computeMetrics();
      $('diagnostics').textContent=`엔진: WebEyeTrack / BlazeGaze CNN\n가속: ${backend||'준비 중'}\n개인 보정: ${quality?.stabilityMode?'홍채 부드러운 추적 모드':adaptation||'준비 중'}\n상태: ${state}\n눈 인식: ${good?'정상':issue||'대기'}\n추론: ${Math.round(inference)}ms\n집중 스코어: ${m.currentScore}점 (예상 나이 ${m.age}세 / ${m.percentile}분위)\n타겟 유지율: ${m.retention.toFixed(1)}% · 홍채 안정도: ${Math.round(m.avgSmooth)}%\n눈 흔들림 속도: ${eyeSpeed.toFixed(3)}\n시선: ${raw?raw.x.toFixed(2)+', '+raw.y.toFixed(2):'—'}\n오류: ${lastPumpError||'없음'}`;
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
