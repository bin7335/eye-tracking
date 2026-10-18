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
