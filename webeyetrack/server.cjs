const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'public'),port=Number(process.env.EYE_DEMO_PORT||8765);
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json','.bin':'application/octet-stream','.wasm':'application/wasm','.txt':'text/plain; charset=utf-8','.jpg':'image/jpeg'};
const server=http.createServer((req,res)=>{
  const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
  const file=pathname==='/legacy.html'?path.resolve(__dirname,'../eye_tracking_demo.html'):path.resolve(root,'.'+(pathname==='/'?'/index.html':pathname));
  if(pathname!=='/legacy.html' && !file.startsWith(root+path.sep)){res.writeHead(403);res.end();return;}
  if(!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);res.end('Not found');return;}
  res.setHeader('Content-Type',types[path.extname(file)]||'application/octet-stream');res.setHeader('Cache-Control','no-store');
  fs.createReadStream(file).pipe(res);
});
server.on('error',e=>{console.error(e.message);process.exitCode=1;});
server.listen(port,'127.0.0.1',()=>console.log('시선 엔진 비교판: http://127.0.0.1:'+server.address().port));
