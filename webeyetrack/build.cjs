const fs=require('node:fs/promises'),path=require('node:path'),esbuild=require('esbuild');
const root=__dirname;
// Preserve upstream files; compatibility fixes are applied only to the compiled copy.
const fixes={name:'webeyetrack-integration-fixes',setup(build){
  build.onLoad({filter:/vendor[\\/]src[\\/]WebEyeTrack\.ts$/},async args=>{
    let contents=await fs.readFile(args.path,'utf8');
    contents=contents.replace('const supportX: SupportX = {','const supportX: SupportX = tf.tidy(() => ({').replace('  };\n\n  // Convert normPogs','  }));\n\n  // Convert normPogs');
    contents=contents.replace('if ( leftEAR < 0.2 || rightEAR < 0.2)', 'if ( leftEAR < 0.12 || rightEAR < 0.12)');
    // Prevent clipping/Kalman from hiding validation errors; the UI uses one time-based filter.
    contents=contents.replace('const kalmanOutput = this.kalmanFilter.step(normPog[0]);','const kalmanOutput = normPog[0];');
    contents=contents.replace(/    kalmanOutput\[0\] = Math\.max[^\n]+\n    kalmanOutput\[1\] = Math\.max[^\n]+\n/,'');
    contents=contents.replace('    });\n  }\n\n  async step(',`    });
    opt.dispose();
    if (this.calibData.supportX.length > 1) tf.dispose([tfEyePatches, tfHeadVectors, tfFaceOrigins3D, tfSupportY]);
    tf.dispose(this.calibData.supportX.flatMap(s => [s.eyePatches, s.headVectors, s.faceOrigins3D]));
    tf.dispose(this.calibData.supportY);
    this.calibData = {supportX: [], supportY: [], timestamps: [], ptType: []};
  }

  async step(`);
    return {contents,loader:'ts',resolveDir:path.dirname(args.path)};
  });
}};
(async()=>{
  await esbuild.build({absWorkingDir:root,entryPoints:['worker.ts'],outfile:'public/engine-worker.js',bundle:true,format:'iife',platform:'browser',target:'chrome100',minify:true,legalComments:'eof',plugins:[fixes]});
  const original=await fs.readFile(path.join(root,'../eye_tracking_demo.html'),'utf8');
  const page=original.replace(/<title>[^<]+<\/title>/,'<title>시선의 힘 · 60초 시선 집중 챌린지 (CNN)</title>').replace(/<script>[\s\S]*?<\/script>/,'<script src="app.js"></script>')
    .replace('AI VISION EXPERIENCE','WEBEYETRACK · CNN')
    .replace('카메라 켜고 시작','CNN 모델 켜고 시작')
    .replace('나에게 맞게 시선을 보정한 뒤, 60초 챌린지가 시작됩니다.','WebEyeTrack CNN을 개인 보정한 뒤 60초 챌린지를 진행합니다.')
    .replace('9개 점으로 시선 보정','9개 점으로 CNN 개인 보정')
    .replace('영상은 브라우저에서 처리되며 저장하거나 서버로 전송하지 않습니다. 첫 실행에는 AI 모델 다운로드가 필요합니다.','영상은 브라우저에서 처리하며 저장·업로드하지 않습니다. WebEyeTrack / BlazeGaze: RedForestAI 연구팀, MIT License. 첫 실행에 얼굴 모델 다운로드가 필요합니다. <a href="LICENSE.txt" target="_blank">라이선스</a>');
  const filter=await fs.readFile(path.join(root,'gaze-filter.js'),'utf8');
  const appBundle=filter+'\n'+await fs.readFile(path.join(root,'app.js'),'utf8');
  await fs.writeFile(path.join(root,'public/index.html'),page);await fs.writeFile(path.join(root,'public/app.js'),appBundle);
  await fs.mkdir(path.join(root,'public/tf-wasm'),{recursive:true});
  for(const file of ['tfjs-backend-wasm.wasm','tfjs-backend-wasm-simd.wasm','tfjs-backend-wasm-threaded-simd.wasm'])await fs.copyFile(path.join(root,'node_modules/@tensorflow/tfjs-backend-wasm/dist',file),path.join(root,'public/tf-wasm',file));
  await fs.copyFile(path.join(root,'vendor/LICENSE'),path.join(root,'public/LICENSE.txt'));
  const repoRoot=path.join(root,'..');
  await fs.writeFile(path.join(repoRoot,'index.html'),page);await fs.writeFile(path.join(repoRoot,'app.js'),appBundle);
  await fs.copyFile(path.join(root,'public/engine-worker.js'),path.join(repoRoot,'engine-worker.js'));
  await fs.copyFile(path.join(root,'public/LICENSE.txt'),path.join(repoRoot,'LICENSE.txt'));
  await fs.cp(path.join(root,'public/web'),path.join(repoRoot,'web'),{recursive:true});
  await fs.cp(path.join(root,'public/tf-wasm'),path.join(repoRoot,'tf-wasm'),{recursive:true});
  await fs.writeFile(path.join(repoRoot,'.nojekyll'),'');
  await esbuild.build({absWorkingDir:root,entryPoints:['realeye-bridge.js'],outfile:'public/realeye-bridge.js',bundle:true,format:'iife',platform:'browser',target:'chrome100',legalComments:'eof'});
  const realeyePage=page.replace('<script src="app.js"></script>','<script src="realeye-bridge.js"></script><script src="realeye-app.js"></script>')
    .replaceAll('WebEyeTrack','RealEye Light').replaceAll('WEBEYETRACK','REALEYE LIGHT').replaceAll('CNN','눈 이미지').replaceAll('9개','17개')
    .replace('RealEye Light / BlazeGaze: RedForestAI 연구팀, MIT License.','RealEye Light 1.1.0: RealEye sp. z o.o. · AGPLv3 / Commercial.').replace('href="LICENSE.txt"','href="REALEYE-LICENSE.txt"')
    .replace('<a href="/legacy.html">기존 방식 비교</a>','<a href="/">WebEyeTrack 비교</a> · <a href="/legacy.html">기존 방식</a>')
    .replace(' · <a href="realeye.html">RealEye Light 테스트</a>','')
    .replace('<h2>체험 설정</h2>','<h2>체험 설정</h2><p class="hint">체험용 넉넉한 판정 · 잠깐 벗어나도 1.2초까지 에너지를 유지합니다.</p>')
    .replace('<a href="REALEYE-LICENSE.txt" target="_blank">라이선스</a>','<a href="REALEYE-LICENSE-AGPL.md" target="_blank">AGPL 라이선스</a> · <a href="https://github.com/RealEye-io/webcam-eyetracker-light-open" target="_blank" rel="noopener noreferrer">공식 소스</a>');
  await fs.writeFile(path.join(root,'public/realeye.html'),realeyePage);
  const realeyeApp=(filter+'\n'+await fs.readFile(path.join(root,'app.js'),'utf8')).replaceAll('WebEyeTrack / BlazeGaze CNN','RealEye Light 1.1.0 · 17점 회귀').replaceAll('WebEyeTrack','RealEye Light').replaceAll('WEBEYETRACK','REALEYE LIGHT').replaceAll('CNN','눈 이미지').replaceAll('9점','17점').replaceAll('9 / 9','17 / 17');
  await fs.writeFile(path.join(root,'public/realeye-app.js'),realeyeApp);
  await fs.copyFile(path.join(root,'node_modules/@realeye-io/webcam-eyetracker-light-open/LICENSE'),path.join(root,'public/REALEYE-LICENSE.txt'));
  if(require('node:fs').existsSync(path.join(root,'public/webgazer-lib.js'))){
    const wgPage=page.replace('<script src="app.js"></script>','<script>if(location.hostname==="127.0.0.1")location.replace(location.href.replace("127.0.0.1","localhost"));</script><script src="webgazer-bridge.js"></script><script src="webgazer-app.js"></script>')
      .replaceAll('WebEyeTrack','WebGazer').replaceAll('WEBEYETRACK','WEBGAZER').replaceAll('CNN','눈 특징 회귀')
      .replace('9개 점으로 눈 특징 회귀 개인 보정','9개 점으로 눈 이미지 보정')
      .replace('<a href="/legacy.html">기존 방식 비교</a>','<a href="/">WebEyeTrack 비교</a> · <a href="/legacy.html">기존 방식</a>')
      .replace(' · <a href="webgazer.html">WebGazer 테스트</a>','')
      .replace('WebGazer / BlazeGaze: RedForestAI 연구팀, MIT License.','WebGazer 3.5.3: Brown WebGazer Team, GPLv3.').replace('href="LICENSE.txt"','href="WEBGAZER-LICENSE.md"');
    await fs.writeFile(path.join(root,'public/webgazer.html'),wgPage);
    const shared=filter+'\n'+await fs.readFile(path.join(root,'app.js'),'utf8');
    await fs.writeFile(path.join(root,'public/webgazer-app.js'),shared.replaceAll('WebEyeTrack / BlazeGaze CNN','WebGazer 3.5.3 · 눈 이미지 회귀').replaceAll('WebEyeTrack','WebGazer').replaceAll('CNN','눈 이미지').replace('추론: ${Math.round(inference)}ms','출력 간격: ${Math.round(inference)}ms'));
    await fs.copyFile(path.join(root,'webgazer-bridge.js'),path.join(root,'public/webgazer-bridge.js'));
  }
  console.log('Built browser worker, CNN model assets, and comparison page.');
})().catch(e=>{console.error(e);process.exitCode=1;});
