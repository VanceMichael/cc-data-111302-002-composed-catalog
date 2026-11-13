export async function inspect(url){
  const response=await fetch(url+'/inventory',{signal:AbortSignal.timeout(2000)});
  if(!response.ok)throw new Error(`目录读取失败: ${response.status}`);
  return response.json();
}
export async function readRaw(url,path){
  const response=await fetch(url+path,{signal:AbortSignal.timeout(2000)});
  if(!response.ok)throw new Error(`资料读取失败: ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}
