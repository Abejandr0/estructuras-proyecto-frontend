#!/usr/bin/env node
import {BloomFilter,Repository} from '@aiverse/core';
import {spawn} from 'node:child_process';
import {mkdir} from 'node:fs/promises';
import path from 'node:path';

const [command, ...args] = process.argv.slice(2);
const bloomFor=(hashes:string[])=>{const filter=new BloomFilter(Math.max(8192,hashes.length*16));for(const h of hashes)filter.add(h);return filter.serialize()};
const api = (url: string, route: string) => `${url.replace(/\/$/, '')}/api/remote/${route}`;
async function request(url: string, route: string, body?: unknown): Promise<unknown> {
  const response = await fetch(api(url, route), body ? {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)} : undefined);
  if (!response.ok) throw new Error(`Remote ${route} failed (${response.status}): ${await response.text()}`);
  return response.json();
}
try {
  if (command === 'init') { await Repository.init(args[0] ?? process.cwd()); console.log('Initialized empty AIVerse repository'); }
  else if (command === 'clone') {
    const [url, directory] = args; if (!url || !directory) throw new Error('Usage: aiverse clone <url> <directory>');
    const target=path.resolve(directory); await mkdir(target,{recursive:true}); const repo=await Repository.init(target);
    const snapshot=await request(url,'pack',{have:[],bloom:bloomFor([])}) as {objects:Array<{hash:string;data:string}>;refs:Record<string,string>;head:string};
    await repo.importRemote(snapshot); if(snapshot.head&&snapshot.refs[snapshot.head])await repo.checkout(snapshot.head,true); console.log(`Cloned ${url} into ${target}`);
  } else if (command === 'serve') {
    const entry = new URL('../../server/dist/index.js', import.meta.url); const child=spawn(process.execPath,[entry.pathname],{stdio:'inherit',env:{...process.env,MINIGIT_REPO:process.cwd()}}); child.on('exit',code=>process.exit(code??0));
  } else if (command === 'push' || command === 'pull') {
    const url=args[0]; if(!url)throw new Error(`Usage: aiverse ${command} <server-url>`); const repo=await Repository.open();
    if(command==='push') { const remote=await request(url,'hashes') as {hashes:string[]}; const snapshot=await repo.remoteSnapshot(remote.hashes,bloomFor(remote.hashes)); await request(url,'push',{snapshot}); console.log('Push completed'); }
    else { const snapshot=await request(url,'pack',{have:await repo.objectHashes(),bloom:bloomFor(await repo.objectHashes())}) as {objects:Array<{hash:string;data:string}>;refs:Record<string,string>;head:string}; await repo.importRemote(snapshot); if(snapshot.head&&snapshot.refs[snapshot.head])await repo.checkout(snapshot.head,true); console.log('Pull completed'); }
  } else {
    const repo=await Repository.open();
    switch(command){
      case 'add': console.log(`Staged ${await repo.add(args.length?args:['.'])} file(s)`); break;
      case 'commit': { const message=args[0]==='-m'?args.slice(1).join(' '):args.join(' '); if(!message)throw new Error('Usage: aiverse commit -m "message"'); console.log(await repo.commit(message)); break; }
      case 'status': console.log(JSON.stringify(await repo.status(),null,2)); break;
      case 'log': for(const e of await repo.log())console.log(`${e.hash.slice(0,8)} ${e.commit.date} ${e.commit.message}`); break;
      case 'branch': if(args[0])await repo.branch(args[0]); console.log((await repo.branches()).join('\n')); break;
      case 'checkout': if(!args[0])throw new Error('Usage: aiverse checkout <branch>'); await repo.checkout(args[0]); break;
      case 'merge': if(!args[0])throw new Error('Usage: aiverse merge <branch>'); {const result=await repo.merge(args[0]);console.log(result.conflicts.length?`Conflicts: ${result.conflicts.join(', ')}`:`Merged ${args[0]} as ${result.hash}`);} break;
      case 'diff': console.log('Use the server API /api/repo/diff to inspect changes.'); break;
      case 'stash': {const action=(args[0]??'push') as 'push'|'apply'|'pop'|'list';console.log(JSON.stringify(await repo.stash(action),null,2));break;}
      case 'reset': console.log(await repo.reset(args[0]??'HEAD',args[1]==='--hard'));break;
      case 'revert': console.log(await repo.revert(args[0]));break;
      default: console.log('AIVerse: init, add, commit, status, log, branch, checkout, merge, serve, clone, push, pull');
    }
  }
} catch(error) { console.error(error instanceof Error?error.message:String(error)); process.exitCode=1; }
