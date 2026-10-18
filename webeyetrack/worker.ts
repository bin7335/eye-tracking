import WebEyeTrack from './vendor/src/WebEyeTrack';
import * as tf from '@tensorflow/tfjs';
import {setWasmPaths} from '@tensorflow/tfjs-backend-wasm';
let tracker:WebEyeTrack|null=null;
let supports=new Map<number,any[]>();
let lastCapture=0;
let chain=Promise.resolve();
async function handle(message:any) {
  const {id,type,payload}=message;
  try {
    if(type==='init') {
      const gpu=await tf.setBackend('webgl').catch(()=>false);
      if(!gpu) {setWasmPaths(payload.baseUrl+'tf-wasm/');await tf.setBackend('wasm');}
      await tf.ready();
      tracker=new WebEyeTrack(9,3600);await tracker.initialize(payload.baseUrl);
      supports.clear();lastCapture=0;
      self.postMessage({id,result:{ready:true,backend:tf.getBackend(),tensors:tf.memory().numTensors}});return;
    }
    if(!tracker)throw Error('Engine not initialized');
    if(type==='step') {
      const result=await tracker.step(payload.frame,payload.timestamp);
      const valid=result.facialLandmarks.length>0 && result.gazeState==='open' && result.normPog.every(Number.isFinite);
      if(valid && payload.capture && payload.timestamp-lastCapture>=220) {
        const entries=supports.get(payload.point)||[];
        if(entries.length<4) {entries.push({eyePatch:result.eyePatch,headVector:result.headVector,origin:result.faceOrigin3D,target:payload.target});supports.set(payload.point,entries);lastCapture=payload.timestamp;}
      }
      self.postMessage({id,result:{normPog:result.normPog,gazeState:result.gazeState,landmarks:result.facialLandmarks,headVector:result.headVector,durations:result.durations,samples:supports.get(payload.point)?.length||0,tensors:tf.memory().numTensors}});return;
    }
    if(type==='adapt') {
      const rows=[...supports.values()].flat();
      if(supports.size!==9 || [...supports.values()].some(a=>a.length<3))throw Error('9점 보정 샘플이 부족합니다.');
      const fineTune=tf.getBackend()==='webgl';
      await tracker.adapt(rows.map(r=>r.eyePatch),rows.map(r=>r.headVector),rows.map(r=>r.origin),rows.map(r=>r.target),fineTune?1:0,1e-5,'calib');
      supports.clear();
      self.postMessage({id,result:{adapted:true,samples:rows.length,adaptation:fineTune?'CNN fine-tuning + affine':'CNN output affine calibration',tensors:tf.memory().numTensors}});return;
    }
    throw Error('Unknown engine command');
  } catch(e:any) {self.postMessage({id,error:e.message||String(e)});}
}
self.onmessage=e=>{chain=chain.then(()=>handle(e.data));};
