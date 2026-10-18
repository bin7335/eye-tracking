const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
(async()=>{
  const urls={
    'public/webgazer-lib.js':'https://cdn.jsdelivr.net/npm/webgazer@3.5.3/dist/webgazer.js',
    'public/WEBGAZER-LICENSE.md':'https://raw.githubusercontent.com/brownhci/WebGazer/3.5.3/LICENSE.md',
    'reference/webgazer-index.mjs':'https://raw.githubusercontent.com/brownhci/WebGazer/3.5.3/src/index.mjs',
    'reference/webgazer-facemesh.mjs':'https://raw.githubusercontent.com/brownhci/WebGazer/3.5.3/src/facemesh.mjs',
    'reference/webgazer-ridge.mjs':'https://raw.githubusercontent.com/brownhci/WebGazer/3.5.3/src/ridgeReg.mjs'
  };
  const files=await Promise.all(Object.entries(urls).map(async([file,url])=>{const r=await fetch(url);if(!r.ok)throw Error(`${r.status} ${url}`);const data=Buffer.from(await r.arrayBuffer());await fs.mkdir(path.dirname(path.join(__dirname,file)),{recursive:true});await fs.writeFile(path.join(__dirname,file),data);return {file,url,bytes:data.length,sha256:crypto.createHash('sha256').update(data).digest('hex')};}));
  await fs.writeFile(path.join(__dirname,'webgazer-upstream.json'),JSON.stringify({version:'3.5.3',files},null,2));console.log('Downloaded pinned WebGazer 3.5.3 and source references.');
})().catch(e=>{console.error(e.message);process.exitCode=1;});
