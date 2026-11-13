import {createSource} from './source.mjs';
const source=await createSource();console.log(JSON.stringify({source:source.url,status:'来源服务就绪'}));let stopping=false;async function stop(){if(stopping)return;stopping=true;await source.close();process.exit(0);}process.on('SIGTERM',stop);process.on('SIGINT',stop);
