import { createServer as httpServer } from 'node:http';
import { fileURLToPath } from 'node:url';import { dirname,resolve } from 'node:path';
import { createDatabase } from './database.js';
import { createOrder,getOrder,inventorySummary,listOrders,listProducts,transitionOrder } from './domain.js';
import { bodyJson,fail,json,staticFile } from './http.js';
const here=dirname(fileURLToPath(import.meta.url));
export function createApp({db=createDatabase(':memory:'),publicDir=resolve(here,'../public')}={}){
 const server=httpServer(async(req,res)=>{const url=new URL(req.url,'http://localhost');try{
  if(req.method==='GET'&&url.pathname==='/api/health')return json(res,200,{status:'ok',service:'ordercore'});
  if(req.method==='GET'&&url.pathname==='/api/products')return json(res,200,{items:listProducts(db)});
  if(req.method==='GET'&&url.pathname==='/api/orders')return json(res,200,{items:listOrders(db)});
  if(req.method==='GET'&&url.pathname==='/api/inventory/summary')return json(res,200,inventorySummary(db));
  if(req.method==='POST'&&url.pathname==='/api/orders'){const result=createOrder(db,await bodyJson(req),req.headers['idempotency-key']);return json(res,result.replayed?200:201,result);}
  const match=url.pathname.match(/^\/api\/orders\/([\w-]+)(?:\/(confirm|cancel))?$/);if(match){const [,id,action]=match;if(req.method==='GET'&&!action)return json(res,200,{order:getOrder(db,id)});if(req.method==='POST'&&action)return json(res,200,{order:transitionOrder(db,id,action==='confirm'?'confirmed':'cancelled')});}
  if(req.method==='GET'&&(url.pathname==='/'||['/app.js','/styles.css'].includes(url.pathname))){const file=url.pathname==='/'?'index.html':url.pathname.slice(1);if(await staticFile(res,publicDir,file))return;}
  return json(res,404,{error:'Route not found'});
 }catch(error){return fail(res,error);}});return {server,db};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){const {server}=createApp({db:createDatabase()});const port=Number(process.env.PORT||3002);server.listen(port,()=>console.log(`OrderCore running at http://localhost:${port}`));for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>server.close(()=>process.exit(0)));}
