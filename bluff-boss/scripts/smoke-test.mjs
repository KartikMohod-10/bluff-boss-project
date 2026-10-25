import assert from 'node:assert/strict';
const URL='ws://127.0.0.1:3000/ws';
function makeClient(label){
 const ws=new WebSocket(URL); const events=[];
 ws.addEventListener('message',e=>{try{events.push(JSON.parse(e.data));}catch{}});
 return {label,ws,events,send(event,data){ws.send(JSON.stringify({event,data}));},async wait(pred,timeout=4000){const start=Date.now();while(Date.now()-start<timeout){const found=events.find(p=>pred(p.event,p.data));if(found)return found;await new Promise(r=>setTimeout(r,10));}throw new Error(label+' timed out waiting; events: '+events.map(e=>e.event+':'+String(e.data?.game?.roundNumber||e.data?.status||'')).slice(-15).join(','));},latestState(){return events.filter(e=>e.event==='room:state').at(-1)?.data;},close(){ws.close();}};
}
const a=makeClient('A'),b=makeClient('B');
const knownAnswers={1:'Octopus',3:'Venus',4:'Honey',6:'Bat',7:'A flamboyance',8:'Koala'};
const completed=[];
try {
 await Promise.all([a.wait(e=>e==='server:hello'),b.wait(e=>e==='server:hello')]);
 a.send('room:create',{name:'Alpha'}); const made=await a.wait(e=>e==='room:created');
 const code=made.data.code; await a.wait((e,d)=>e==='room:state'&&d.status==='lobby');
 b.send('room:join',{code,name:'Bravo'}); await b.wait(e=>e==='room:joined');
 await Promise.all([a.wait((e,d)=>e==='room:state'&&d.players.length===2),b.wait((e,d)=>e==='room:state'&&d.players.length===2)]);
 b.send('player:ready',{ready:true});
 await a.wait((e,d)=>e==='room:state'&&d.canStart); a.send('game:start');
 await Promise.all([a.wait((e,d)=>e==='room:state'&&d.status==='playing'&&d.game?.roundNumber===1&&d.game?.phase==='submit'),b.wait((e,d)=>e==='room:state'&&d.status==='playing'&&d.game?.roundNumber===1&&d.game?.phase==='submit')]);
 for(let round=1;round<=8;round++){
   const ar=a.latestState(),br=b.latestState();
   assert.equal(ar.game.roundNumber,round);assert.equal(br.game.roundNumber,round);
   if(ar.game.type==='story'){
     const target=ar.game.storytellerId;
     const s=ar.viewerId===target?a:b, v=ar.viewerId===target?b:a;
     const truth=round===5;
     s.send('round:submit',{text:round===2?'I once won a pie-eating contest at a county fair.':'I accidentally boarded the wrong train and discovered a hidden seaside town.',truth});
     const voteState=await v.wait((e,d)=>e==='room:state'&&d.game?.roundNumber===round&&d.game?.phase==='vote');
     assert.equal(voteState.data.game.storytellerId,target);
     v.send('round:vote',{choice:truth?'true':'fake'});
   } else {
     // Verify a submitted answer remains private before the vote opens.
     a.send('round:submit',{text:`Definitely fake answer from Alpha in round ${round}`});
     await a.wait((e,d)=>e==='room:state'&&d.game?.roundNumber===round&&d.game?.submittedCount===1);
     assert.equal(b.latestState().game.options.length,0);
     b.send('round:submit',{text:`A very convincing invented answer from Bravo in round ${round}`});
     await Promise.all([a.wait((e,d)=>e==='room:state'&&d.game?.roundNumber===round&&d.game?.phase==='vote'),b.wait((e,d)=>e==='room:state'&&d.game?.roundNumber===round&&d.game?.phase==='vote')]);
     const answer=knownAnswers[round];
     const ao=a.latestState().game.options.find(o=>o.text===answer);
     const bo=b.latestState().game.options.find(o=>o.text===answer);
     assert.ok(ao && bo, `expected truth ${answer} in round ${round}`);
     a.send('round:vote',{choice:ao.id}); b.send('round:vote',{choice:bo.id});
   }
   await Promise.all([a.wait((e,d)=>e==='room:state'&&d.game?.roundNumber===round&&d.game?.phase==='results'),b.wait((e,d)=>e==='room:state'&&d.game?.roundNumber===round&&d.game?.phase==='results')]);
   const result=a.latestState();
   assert.ok(result.players.every(p=>p.lives===3),`expected no life loss in round ${round}`);
   completed.push({round,type:result.game.type,phase:result.game.phase,correctAnswers:result.game.results.votes.filter(v=>v.correct).length});
   if(round<8){a.send('game:next-round');await Promise.all([a.wait((e,d)=>e==='room:state'&&d.game?.roundNumber===round+1&&d.game?.phase==='submit'),b.wait((e,d)=>e==='room:state'&&d.game?.roundNumber===round+1&&d.game?.phase==='submit')]);}
 }
 assert.equal(a.latestState().status,'ended');
 assert.equal(b.latestState().status,'ended');
 assert.equal(a.latestState().game.roundNumber,8);
 assert.ok(a.latestState().players.every(p=>p.score>0));
 console.log(JSON.stringify({passed:true,roomCode:code,players:2,roundsCompleted:completed.length,completed,finalPlayers:a.latestState().players.map(p=>({name:p.name,score:p.score,bluffPoints:p.bluffPoints,lives:p.lives})),status:a.latestState().status},null,2));
} finally { a.close(); b.close(); }


// A second room deliberately votes for the opponent's fake answer to verify
// the life penalty and successful-bluff points.
const c = makeClient('C'), d = makeClient('D');
try {
  await Promise.all([c.wait(e=>e==='server:hello'), d.wait(e=>e==='server:hello')]);
  c.send('room:create', { name: 'Mischief' });
  const made = await c.wait(e=>e==='room:created');
  d.send('room:join', { code: made.data.code, name: 'Mayhem' });
  await d.wait(e=>e==='room:joined');
  await c.wait((e,data)=>e==='room:state'&&data.players.length===2);
  d.send('player:ready', { ready: true });
  await c.wait((e,data)=>e==='room:state'&&data.canStart);
  c.send('game:start');
  await Promise.all([c.wait((e,data)=>e==='room:state'&&data.game?.roundNumber===1&&data.game?.phase==='submit'),d.wait((e,data)=>e==='room:state'&&data.game?.roundNumber===1&&data.game?.phase==='submit')]);
  c.send('round:submit', { text: 'Fake answer from Mischief' });
  const duplicateCheck = c.wait((e,data)=>e==='game:error'&&/already been submitted/i.test(data.message));
  c.send('round:submit', { text: 'Duplicate answer attempt' });
  await duplicateCheck;
  d.send('round:submit', { text: 'Fake answer from Mayhem' });
  await Promise.all([c.wait((e,data)=>e==='room:state'&&data.game?.phase==='vote'),d.wait((e,data)=>e==='room:state'&&data.game?.phase==='vote')]);
  const cPick = c.events.filter(e=>e.event==='room:state').at(-1).data.game.options.find(o=>o.text==='Fake answer from Mayhem');
  const dPick = d.events.filter(e=>e.event==='room:state').at(-1).data.game.options.find(o=>o.text==='Fake answer from Mischief');
  assert.ok(cPick && dPick);
  c.send('round:vote',{choice:cPick.id}); d.send('round:vote',{choice:dPick.id});
  await Promise.all([c.wait((e,data)=>e==='room:state'&&data.game?.phase==='results'),d.wait((e,data)=>e==='room:state'&&data.game?.phase==='results')]);
  const players = c.events.filter(e=>e.event==='room:state').at(-1).data.players;
  assert.ok(players.every(p=>p.score===2 && p.lives===2 && p.bluffPoints===2));
  console.log(JSON.stringify({ scoringCheck: 'passed', wrongVotesCostLives: true, bluffAuthorsEarnPoints: true, duplicateSubmissionRejected: true }, null, 2));
} finally { c.close(); d.close(); }
