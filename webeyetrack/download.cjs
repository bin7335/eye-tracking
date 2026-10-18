// Fetch only public, pinned upstream source and model assets. Never execute downloaded scripts.
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
async function save(url,destination) {
  const r=await fetch(url);if(!r.ok)throw Error(`${r.status} ${url}`);
  const b=Buffer.from(await r.arrayBuffer());await fs.mkdir(path.dirname(destination),{recursive:true});await fs.writeFile(destination,b);
  return {url,path:path.relative(__dirname,destination),bytes:b.length,sha256:crypto.createHash('sha256').update(b).digest('hex')};
}
(async()=>{
  const r=await fetch('https://api.github.com/repos/RedForestAI/WebEyeTrack/commits/main');if(!r.ok)throw Error('GitHub revision lookup failed');
  const commit=(await r.json()).sha;
  const tr=await fetch(`https://api.github.com/repos/RedForestAI/WebEyeTrack/git/trees/${commit}?recursive=1`);const tree=(await tr.json()).tree;
  const chosen=tree.filter(f=>f.type==='blob' && ((f.path.startsWith('js/src/') && !f.path.endsWith('.test.ts')) || f.path==='LICENSE' || f.path.startsWith('js/examples/minimal-example/public/web/')));
  const assets=await Promise.all(chosen.map(f=>{
    const local=f.path==='LICENSE'?'vendor/LICENSE':f.path.startsWith('js/src/')?'vendor/src/'+f.path.slice(7):'public/web/'+f.path.split('/').at(-1);
    return save(`https://raw.githubusercontent.com/RedForestAI/WebEyeTrack/${commit}/${f.path}`,path.join(__dirname,local));
  }));
  assets.push(await save('https://storage.googleapis.com/mediapipe-assets/portrait.jpg',path.join(__dirname,'test-assets/portrait.jpg')));
  await fs.writeFile(path.join(__dirname,'upstream.json'),JSON.stringify({repository:'https://github.com/RedForestAI/WebEyeTrack',commit,assets},null,2));
  console.log(`Downloaded ${assets.length} files from WebEyeTrack ${commit}.`);
})().catch(e=>{console.error(e.message);process.exitCode=1;});
