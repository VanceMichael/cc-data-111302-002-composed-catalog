import {createSource} from './source.mjs';
import {inspect} from './client.mjs';
const source=await createSource();try{console.log('来源目录单次读取');console.log(JSON.stringify(await inspect(source.url),null,2));}finally{await source.close();}
