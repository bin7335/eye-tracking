const fs=require('node:fs/promises'),path=require('node:path');
(async()=>{
 const metadata=await(await fetch('https://registry.npmjs.org/@realeye-io%2fwebcam-eyetracker-light-open/1.1.0')).json();
 const commit=metadata.gitHead||(await(await fetch('https://api.github.com/repos/RealEye-io/webcam-eyetracker-light-open/commits/main')).json()).sha;
 if(!/^[a-f0-9]{40}$/.test(commit))throw Error('Missing upstream revision');
 for(const name of ['LICENSE-AGPL.md','LICENSE-COMMERCIAL.md']){const r=await fetch(`https://raw.githubusercontent.com/RealEye-io/webcam-eyetracker-light-open/${commit}/${name}`);if(!r.ok)throw Error(`Notice download ${r.status}`);await fs.writeFile(path.join(__dirname,'public','REALEYE-'+name),await r.text());}
 await fs.writeFile(path.join(__dirname,'realeye-upstream.json'),JSON.stringify({package:metadata.name,version:metadata.version,integrity:metadata.dist.integrity,sourceCommit:commit,source:`https://github.com/RealEye-io/webcam-eyetracker-light-open/tree/${commit}`},null,2));
 console.log('Downloaded official RealEye license notices; npm version pinned to 1.1.0.');
})().catch(e=>{console.error(e);process.exitCode=1;});
