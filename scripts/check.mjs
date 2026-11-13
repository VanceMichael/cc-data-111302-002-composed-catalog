import {readdir} from 'node:fs/promises';
import {join} from 'node:path';import {spawnSync} from 'node:child_process';
async function check(directory){for(const entry of await readdir(directory,{withFileTypes:true})){const path=join(directory,entry.name);if(entry.isDirectory())await check(path);else if(path.endsWith('.mjs')){const result=spawnSync(process.execPath,['--check',path],{stdio:'inherit'});if(result.status!==0)process.exit(result.status||1);}}}
await check('src');await check('test');console.log('语法检查完成');
