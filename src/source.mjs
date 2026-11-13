import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';

export function json(response,value,status=200){response.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});response.end(JSON.stringify(value));}
export async function createSource({port=0,host='127.0.0.1'}={}){
  const state=JSON.parse(await readFile(new URL('../fixtures/source.json',import.meta.url),'utf8'));
  
  const pages={"/index.html": "index.html", "/": "index.html"};
  const server=http.createServer(async(request,response)=>{
    try{
      const url=new URL(request.url,'http://local.test');let text='';
      for await(const chunk of request){text+=chunk;if(text.length>8*1024*1024){json(response,{error:'控制请求过大'},413);return;}}
      let body={};if(text){try{body=JSON.parse(text);}catch{return json(response,{error:'JSON无效'},400);}}
      if(url.pathname==='/health')return json(response,{status:'ok'});
      if(url.pathname==='/state'||url.pathname==='/inventory')return json(response,state);
      if(url.pathname==='/control'&&request.method==='POST'){Object.assign(state,body); return json(response,state);}
      if(Object.hasOwn(pages,url.pathname)){response.setHeader('Content-Type','text/html; charset=utf-8');return response.end(await readFile(new URL('../public/'+pages[url.pathname],import.meta.url)));}
      if (url.pathname === '/quote.html') { if (state.frameDenied) return json(response,{error:'未授权'},403); response.setHeader('Content-Type','text/html; charset=utf-8'); return response.end(`<body data-device="${state.device}" data-generation="${state.generation}"><span id="price">${state.price}</span></body>`); }
      return json(response,{error:'资源不存在'},404);
    }catch(error){if(!response.headersSent)json(response,{error:error.message},500);else response.destroy();}
  });
  await new Promise(resolve=>server.listen(port,host,resolve));
  return {url:`http://127.0.0.1:${server.address().port}`,state,close:async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}};
}
