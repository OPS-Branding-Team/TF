import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const ROOT=path.dirname(fileURLToPath(import.meta.url));
const DATA=process.env.DATA_DIR || path.join(ROOT,'data');
fs.mkdirSync(DATA,{recursive:true});
const db=new DatabaseSync(path.join(DATA,'workshop.db'));
db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
const USERS=['김세환','이유정','심승선','차한나','이수민','하지인','김미송','최우재','박온','임세호'];
const ABILITIES=[
 ['echo','에코','복제','마지막에 점수를 보지 않고 원하는 1명과 전체 점수 교환'],
 ['moira','모이라','생체 흡수','원하는 1명의 점수 2점 빼앗기'],
 ['junkrat','정크랫','대박 아니면 쪽박','주사위에 따라 -2 ~ +4점'],
 ['symmetra','시메트라','순간이동기','다음 경기 시작 전 다른 팀의 사람과 팀 교환'],
 ['tracer','트레이서','시간 역행','본인의 점수 봉투 또는 팀 추첨 1회 재추첨'],
 ['lucio','루시우','분위기 전환','현재 팀원 전원 +1점'],
 ['cassidy','캐서디','석양의 무법자','지목한 사람과 가위바위보. 승리 시 본인 +2점, 패배 시 상대 +2점'],
 ['sigma','시그마','중력 붕괴','본인 포함 여부 선택 후 무작위 2명의 점수 교환'],
 ['reinhardt','라인하르트','방벽 방어','자신에게 사용된 초능력 1회 방어, 미발동 시 +1점'],
 ['mercy','메르시','발키리','무작위 3명에게 각각 +1점']
];
const MATCHES=[['bowling1','볼링 1라운드'],['bowling2','볼링 2라운드'],['ow1','오버워치 1경기'],['ow2','오버워치 2경기']];
const QUESTIONS=[['이구동성','평생 하나만 먹는다면? 짜장 vs 짬뽕'],['이구동성','10억 받기 vs 평생 주 3일 근무'],['이구동성','능력 하나를 얻는다면? 순간이동 vs 투명인간'],['이구동성','하나만 고른다면? 서든어택 vs 낙원'],['5초 릴레이','넥슨 게임 이름'],['5초 릴레이','치킨 브랜드'],['5초 릴레이','편의점 이름'],['5초 릴레이','대한민국 대통령 이름'],['5초 릴레이','아이스크림 이름']];
const BAG=[2,2,1,1,1,0,0,0,-1,-1];
const WIN=[3,3,4,4,5],LOSE=[2,2,3,3,3];
const ADMIN_PIN=process.env.ADMIN_PIN||'0311';
function now(){return new Date().toISOString()}
function hash(s){return crypto.scryptSync(s,'last-pick-access-v1',32).toString('hex')}
function shuf(arr){let a=[...arr];for(let i=a.length-1;i>0;i--){let j=crypto.randomInt(i+1);[a[i],a[j]]=[a[j],a[i]]}return a}
function meta(k){return db.prepare('SELECT value FROM settings WHERE key=?').get(k)?.value}
function setMeta(k,v){db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k,String(v))}
function rowUser(id){return db.prepare('SELECT id,name,ability,ability_used,bag,bag_num FROM users WHERE id=?').get(id)}
function allUsers(){return db.prepare('SELECT id,name,ability,ability_used,bag,bag_num FROM users ORDER BY id').all()}
function score(id){return db.prepare('SELECT COALESCE(SUM(points),0) AS s FROM score_events WHERE user_id=?').get(id).s}
function addScore(id,points,reason,source='manual'){if(!Number.isInteger(points)||Math.abs(points)>100)throw Error('잘못된 점수');db.prepare('INSERT INTO score_events(user_id,points,reason,source,created_at) VALUES(?,?,?,?,?)').run(id,points,reason,source,now())}
function swapScores(a,b,reason){let sa=score(a),sb=score(b);addScore(a,sb-sa,reason);addScore(b,sa-sb,reason)}
function isAdminSession(s){return s?.is_admin===1}
function abilityOf(u){return ABILITIES.find(a=>a[0]===u.ability)}
function participants(ids){return ids.map(id=>rowUser(id)).filter(Boolean)}
function parseTeams(m){return JSON.parse(db.prepare('SELECT teams FROM matches WHERE id=?').get(m)?.teams||'{"A":[],"B":[]}')}
function matchRow(id){return db.prepare('SELECT * FROM matches WHERE id=?').get(id)}
function response(res,code,obj,headers={}){let data=JSON.stringify(obj);res.writeHead(code,{'content-type':'application/json; charset=utf-8','cache-control':'no-store',...headers});res.end(data)}
function fail(code,msg){let e=new Error(msg);e.status=code;throw e}
function ensure(cond,msg){if(!cond)fail(400,msg)}
function saveTeams(id,teams){let m=matchRow(id);ensure(m,'경기를 찾지 못했습니다');ensure(!m.completed,'완료된 경기의 팀은 변경할 수 없습니다');ensure(teams.A.length===5&&teams.B.length===5,'각 팀 5명으로 구성해주세요');ensure(new Set([...teams.A,...teams.B]).size===10,'참가자 중복 또는 누락');db.prepare('UPDATE matches SET teams=? WHERE id=?').run(JSON.stringify(teams),id)}
function abilityUsed(uid,note){db.prepare('UPDATE users SET ability_used=1,ability_note=? WHERE id=?').run(note||'',uid)}
function isBlocked(targetId,attackerId){let user=rowUser(targetId);if(user?.ability==='reinhardt'&&!user.ability_used){abilityUsed(targetId,'방벽 발동: '+rowUser(attackerId).name+'의 초능력 방어');return true}return false}
function tx(fn){db.exec('BEGIN IMMEDIATE');try{let v=fn();db.exec('COMMIT');return v}catch(e){db.exec('ROLLBACK');throw e}}
function setup(){db.exec(`
CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY,name TEXT UNIQUE NOT NULL,code_hash TEXT NOT NULL,ability TEXT,ability_used INTEGER DEFAULT 0,ability_note TEXT DEFAULT '',bag INTEGER,bag_num INTEGER);
CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,user_id INTEGER NOT NULL,is_admin INTEGER DEFAULT 0,created_at TEXT,FOREIGN KEY(user_id) REFERENCES users(id));
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS score_events(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL,points INTEGER NOT NULL,reason TEXT NOT NULL,source TEXT NOT NULL,created_at TEXT NOT NULL,FOREIGN KEY(user_id) REFERENCES users(id));
CREATE TABLE IF NOT EXISTS matches(id TEXT PRIMARY KEY,label TEXT,teams TEXT NOT NULL,winner TEXT,completed INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS bets(match_id TEXT,user_id INTEGER,bet INTEGER,PRIMARY KEY(match_id,user_id));
CREATE TABLE IF NOT EXISTS lunch(question INTEGER,user_id INTEGER,success INTEGER,PRIMARY KEY(question,user_id));
CREATE TABLE IF NOT EXISTS logs(id INTEGER PRIMARY KEY AUTOINCREMENT,text TEXT,created_at TEXT);
CREATE TABLE IF NOT EXISTS announcements(id INTEGER PRIMARY KEY AUTOINCREMENT,title TEXT NOT NULL,body TEXT NOT NULL,created_at TEXT NOT NULL);
`);
if(!meta('initialized')){
 const codes=[];let ids=USERS.map((n,i)=>{let code=String(crypto.randomInt(100000,999999));codes.push({name:n,code});db.prepare('INSERT INTO users(id,name,code_hash) VALUES(?,?,?)').run(i+1,n,hash(code));return i+1});
 for(let [k,label] of MATCHES)db.prepare('INSERT INTO matches(id,label,teams) VALUES(?,?,?)').run(k,label,JSON.stringify({A:ids.slice(0,5),B:ids.slice(5)}));
 setMeta('initialized','1');setMeta('draw_open','0');setMeta('revealed','0');setMeta('bag_values',JSON.stringify(shuf(BAG)));setMeta('access_codes',JSON.stringify(codes));
 // lunch team selection defaults as three equal groups, organizer not in table
 setMeta('lunch_teams',JSON.stringify([ids.filter(i=>i!==2).slice(0,3),ids.filter(i=>i!==2).slice(3,6),ids.filter(i=>i!==2).slice(6,9)]));
 }
}
setup();
db.prepare("UPDATE users SET name='임세호' WHERE name='김세호'").run();
function announce(title,body){db.prepare('INSERT INTO announcements(title,body,created_at) VALUES(?,?,?)').run(title,body,now())}
function auth(req){let tok=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('lastpick='))?.slice(9);if(!tok)return null;let s=db.prepare('SELECT * FROM sessions WHERE token_hash=?').get(hash(tok));if(!s)return null;return {...s,user:rowUser(s.user_id)}}
function admin(req){let s=auth(req);if(!isAdminSession(s))fail(403,'관리자 인증이 필요합니다');return s}
function log(s){db.prepare('INSERT INTO logs(text,created_at) VALUES(?,?)').run(s,now())}
function globalState(session){let revealed=meta('revealed')==='1';let users=allUsers();let my=session.user;let match= db.prepare('SELECT * FROM matches').all().map(m=>({id:m.id,label:m.label,teams:JSON.parse(m.teams),winner:m.winner,completed:!!m.completed}));let used=users.filter(u=>u.ability_used).map(u=>({name:u.name,hero:abilityOf(u)?.[1],title:abilityOf(u)?.[2],detail:abilityOf(u)?.[3]}));return {drawOpen:meta('draw_open')==='1',announcements:db.prepare('SELECT id,title,body FROM announcements ORDER BY id DESC LIMIT 15').all().reverse(),me:{id:my.id,name:my.name,ability:my.ability,ability_used:!!my.ability_used,detail:abilityOf(my)?.[3],title:abilityOf(my)?.[2],hero:abilityOf(my)?.[1],bag:my.bag,bag_num:my.bag_num},admin:!!session.is_admin,heroes:ABILITIES.map(a=>({id:a[0],hero:a[1],title:a[2]})),used,revealed,people:users.map(u=>({id:u.id,name:u.name,...(revealed||session.is_admin?{score:score(u.id),ability:u.ability,used:!!u.ability_used,bag:u.bag}:{} )})),matches:match,lunchTeams:JSON.parse(meta('lunch_teams')),bagsTaken:users.map(u=>u.bag_num).filter(v=>v!==null),...((revealed||session.is_admin)?{scoreEvents:db.prepare('SELECT * FROM score_events ORDER BY id').all()}:{}),...(session.is_admin?{questions:QUESTIONS,abilities:ABILITIES.map(a=>({id:a[0],hero:a[1],title:a[2],detail:a[3]})),codes:JSON.parse(meta('access_codes')),lunch:db.prepare('SELECT * FROM lunch').all(),bets:db.prepare('SELECT * FROM bets').all(),logs:db.prepare('SELECT * FROM logs ORDER BY id DESC LIMIT 30').all()}:{} )};}
const limits=new Map();function ratelimit(req){let ip=req.socket.remoteAddress||'anon';let x=limits.get(ip)||{n:0,until:0};if(Date.now()>x.until)x={n:0,until:Date.now()+60000};x.n++;limits.set(ip,x);if(x.n>180)fail(429,'잠시 후 다시 시도해주세요')}
async function body(req){let chunks=[],size=0;for await(const ch of req){size+=ch.length;if(size>20000)fail(413,'요청 크기 초과');chunks.push(ch)}try{return JSON.parse(Buffer.concat(chunks).toString()||'{}')}catch{fail(400,'잘못된 요청')}}
function serve(req,res){let target=decodeURIComponent(new URL(req.url,'http://localhost').pathname);if(target==='/')target='/index.html';let name=path.normalize(path.join(ROOT,'public',target));if(!name.startsWith(path.join(ROOT,'public')+path.sep))return response(res,404,{error:'Not found'});try{let b=fs.readFileSync(name);let ext=path.extname(name);res.writeHead(200,{'content-type':({'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.webmanifest':'application/manifest+json'}[ext]||'application/octet-stream'),'cache-control':ext==='.html'?'no-store':'public, max-age=300'});res.end(b)}catch{response(res,404,{error:'Not found'})}}
async function api(req,res){ratelimit(req);let p=new URL(req.url,'http://local').pathname;let b=req.method==='POST'?await body(req):{};
 if(p==='/api/admin/bootstrap'&&req.method==='POST'){ensure(String(b.pin||'')===ADMIN_PIN,'관리자 비밀번호가 틀렸습니다');let token=crypto.randomBytes(32).toString('hex');db.prepare('INSERT INTO sessions(token_hash,user_id,is_admin,created_at) VALUES(?,?,1,?)').run(hash(token),2,now());return response(res,200,{ok:true},{'set-cookie':`lastpick=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=604800${process.env.NODE_ENV==='production'?'; Secure':''}`})}
 if(p==='/api/login'&&req.method==='POST'){let u=db.prepare('SELECT * FROM users WHERE name=?').get(String(b.name||''));ensure(u&&hash(String(b.code||''))===u.code_hash,'이름 또는 개인 접속 코드가 다릅니다');let token=crypto.randomBytes(32).toString('hex');db.prepare('INSERT INTO sessions(token_hash,user_id,created_at) VALUES(?,?,?)').run(hash(token),u.id,now());return response(res,200,{ok:true},{'set-cookie':`lastpick=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=604800${process.env.NODE_ENV==='production'?'; Secure':''}`})}
 if(p==='/api/logout'){let s=auth(req);if(s)db.prepare('DELETE FROM sessions WHERE token_hash=?').run(s.token_hash);return response(res,200,{ok:true},{'set-cookie':'lastpick=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax'})}
 let s=auth(req);if(!s)fail(401,'로그인이 필요합니다');
 if(p==='/api/state')return response(res,200,globalState(s));
 if(p==='/api/admin/login'){ensure(String(b.pin||'')===ADMIN_PIN,'관리자 비밀번호가 틀렸습니다');db.prepare('UPDATE sessions SET is_admin=1 WHERE token_hash=?').run(s.token_hash);log(s.user.name+' 관리자 입장');return response(res,200,{ok:true})}
 if(p==='/api/admin/exit'){db.prepare('UPDATE sessions SET is_admin=0 WHERE token_hash=?').run(s.token_hash);return response(res,200,{ok:true})}
 if(p==='/api/bet'){ensure(['ow1','ow2'].includes(b.match),'오버워치 경기만 가능');let m=matchRow(b.match);ensure(!m.completed,'종료된 경기');ensure(JSON.parse(m.teams).A.includes(s.user_id)||JSON.parse(m.teams).B.includes(s.user_id),'팀 미배정');db.prepare('INSERT INTO bets(match_id,user_id,bet) VALUES(?,?,1) ON CONFLICT(match_id,user_id) DO UPDATE SET bet=1').run(b.match,s.user_id);return response(res,200,{ok:true})}
 if(p==='/api/draw'){ensure(meta('draw_open')==='1','관리자가 아직 초능력 추첨을 열지 않았습니다');return response(res,200,tx(()=>{let u=rowUser(s.user_id);ensure(!u.ability,'이미 초능력을 뽑았습니다');let used=allUsers().map(x=>x.ability).filter(Boolean);let avail=ABILITIES.filter(a=>!used.includes(a[0]));ensure(avail.length,'남은 초능력이 없습니다');let ab=avail[crypto.randomInt(avail.length)];db.prepare('UPDATE users SET ability=? WHERE id=?').run(ab[0],u.id);log(u.name+' 초능력 추첨');return {ok:true,hero:ab[1],title:ab[2]}}))}
 if(p==='/api/bag'){return response(res,200,tx(()=>{let u=rowUser(s.user_id);ensure(u.bag_num===null,'이미 가방을 선택했습니다');let n=Number(b.number);ensure(Number.isInteger(n)&&n>=1&&n<=10,'가방 번호 오류');ensure(!db.prepare('SELECT 1 FROM users WHERE bag_num=?').get(n),'이미 선택한 가방입니다');let bag=JSON.parse(meta('bag_values'))[n-1];db.prepare('UPDATE users SET bag=?,bag_num=? WHERE id=?').run(bag,n,u.id);addScore(u.id,bag,'운명의 가방 '+n+'번','bag');log(u.name+' 가방 '+n+'번 선택');return {ok:true,bag}}))}
 admin(req);
 if(p==='/api/admin/draw-open'){setMeta('draw_open',b.open?'1':'0');if(b.open)announce('🔮 초능력 추첨 시작','초능력 뽑기 메뉴에서 각자 카드 1장을 뽑아주세요!');return response(res,200,{ok:true})}
 if(p==='/api/admin/reveal'){setMeta('revealed',b.revealed?'1':'0');log('전체 점수 '+(b.revealed?'공개':'비공개'));if(b.revealed)announce('🏆 최종 순위 공개','시상식 메뉴에서 전체 점수와 순위를 확인하세요!');return response(res,200,{ok:true})}
 if(p==='/api/admin/random-teams'){return response(res,200,tx(()=>{let key=String(b.match||'');ensure(['bowling1','ow1','ow2'].includes(key),'무작위 팀 편성 가능한 경기만 선택');let m=matchRow(key);ensure(!m.completed,'종료된 경기입니다');let ids=allUsers().map(x=>x.id),teams;
 if(key.startsWith('ow')){let remaining=shuf(ids.filter(x=>![3,8].includes(x)));teams={A:[3,...remaining.slice(0,4)],B:[8,...remaining.slice(4)]}}
 else{let mixed=shuf(ids);teams={A:mixed.slice(0,5),B:mixed.slice(5)}}
 saveTeams(key,teams);let title=key.startsWith('ow')?'🎮 오버워치 팀 추첨 결과':'🎳 볼링 팀 추첨 결과';let body=['A팀: '+teams.A.map(x=>rowUser(x).name).join(' · '),'B팀: '+teams.B.map(x=>rowUser(x).name).join(' · ')].join('\n');announce(title,body);log(m.label+' 랜덤 팀 편성 공개');return {ok:true,teams,body}}))}
 if(p==='/api/admin/announce'){ensure(b.title&&b.body,'제목 및 내용을 입력해주세요');announce(String(b.title).slice(0,80),String(b.body).slice(0,500));return response(res,200,{ok:true})}
 if(p==='/api/admin/teams'){saveTeams(b.match,{A:b.A.map(Number),B:allUsers().map(u=>u.id).filter(id=>!b.A.map(Number).includes(id))});log(b.match+' 팀 변경');return response(res,200,{ok:true})}
 if(p==='/api/admin/lunch-teams'){let teams=b.teams.map(x=>x.map(Number));ensure(teams.length===3&&teams.every(t=>t.length===3)&&new Set(teams.flat()).size===9&&!teams.flat().includes(2),'이유정을 제외한 9명을 3명씩 배정');setMeta('lunch_teams',JSON.stringify(teams));return response(res,200,{ok:true})}
 if(p==='/api/admin/lunch'){return response(res,200,tx(()=>{let q=Number(b.question),team=Number(b.team),success=!!b.success;ensure(q>=0&&q<9&&team>=0&&team<3,'문항 오류');let ids=JSON.parse(meta('lunch_teams'))[team];for(let id of ids){let old=db.prepare('SELECT success FROM lunch WHERE question=? AND user_id=?').get(q,id);let before=old?.success||0;let after=success?1:0;db.prepare('INSERT INTO lunch(question,user_id,success) VALUES(?,?,?) ON CONFLICT(question,user_id) DO UPDATE SET success=excluded.success').run(q,id,after);if(before!==after)addScore(id,after-before,'점심 '+(q+1)+'번 '+(team+1)+'팀','lunch');}
 let others=allUsers().filter(u=>u.id!==2).map(u=>scoreFromSource(u.id,'lunch'));let v=Math.round(others.reduce((a,c)=>a+c,0)/9);let cur=scoreFromSource(2,'lunch');if(cur!==v)addScore(2,v-cur,'점심 진행자 평균점수','lunch');return {ok:true}}))}
 if(p==='/api/admin/match'){return response(res,200,tx(()=>{let m=matchRow(b.match);ensure(m&&!m.completed,'이미 완료된 경기');ensure(['A','B'].includes(b.winner),'승리팀 선택');let t=JSON.parse(m.teams);let events=[];for(let side of ['A','B']){let shuffled=shuf(side===b.winner?WIN:LOSE);t[side].forEach((uid,i)=>{addScore(uid,shuffled[i],m.label+' '+(side===b.winner?'승리':'패배')+' 봉투','match:'+m.id);events.push({uid,points:shuffled[i]})})}
 if(m.id.startsWith('ow')){let winners=t[b.winner];for(let id of winners){let bet=db.prepare('SELECT bet FROM bets WHERE match_id=? AND user_id=?').get(m.id,id);if(bet?.bet)addScore(id,1,m.label+' 본인 팀 승리 예측 성공','bet:'+m.id)}}
 db.prepare('UPDATE matches SET completed=1,winner=? WHERE id=?').run(b.winner,m.id);log(m.label+' 종료 '+b.winner+'승');return {ok:true,events}}))}
 if(p==='/api/admin/lucky'){return response(res,200,tx(()=>{let m=matchRow(b.match),id=Number(b.user),target=Number(b.target);ensure(m&&m.id.startsWith('bowling'),'볼링에서만 사용 가능');let t=JSON.parse(m.teams);let side=t.A.includes(id)?'A':t.B.includes(id)?'B':null;ensure(side,'경기 참가자 선택');let count=db.prepare("SELECT COUNT(*) AS n FROM logs WHERE text LIKE ?").get('LUCKY:'+b.match+':'+side+':%').n;ensure(count<2,'팀별 최대 2회');let kind=crypto.randomInt(3),desc=['팀 보너스','개인 보너스','행운 나눔'][kind];if(kind===0)t[side].forEach(x=>addScore(x,1,'볼링 '+desc,'lucky:'+b.match));else if(kind===1)addScore(id,1,'볼링 '+desc,'lucky:'+b.match);else{ensure(t[side].includes(target),'행운 나눔 대상은 같은 팀');addScore(target,1,'볼링 '+desc,'lucky:'+b.match)}announce('🎳 볼링 럭키 찬스',rowUser(id).name+' · '+desc);log('LUCKY:'+b.match+':'+side+':'+desc);return {ok:true,kind:desc}}))}
 if(p==='/api/admin/adjust'){let id=Number(b.user),delta=Number(b.points);ensure(rowUser(id)&&Number.isInteger(delta)&&Math.abs(delta)<=20&&delta!==0,'대상 또는 점수 오류');addScore(id,delta,'관리자 조정: '+String(b.reason||'점수 수정').slice(0,80));log(rowUser(id).name+' 점수 조정 '+delta);return response(res,200,{ok:true})}
 if(p==='/api/admin/ability'){return response(res,200,tx(()=>useAbility(b)))}
 if(p==='/api/admin/reinhardt'){return response(res,200,tx(()=>{let u=allUsers().find(x=>x.ability==='reinhardt');ensure(u&&!u.ability_used,'이미 사용됨');addScore(u.id,1,'라인하르트 방벽 미발동 보상');abilityUsed(u.id,'미발동 +1점');announce('🛡️ 라인하르트 방어 종료',u.name+' +1점');return {ok:true,note:'+1점'}}))}
 fail(404,'존재하지 않는 기능');
}
function scoreFromSource(id,source){return db.prepare('SELECT COALESCE(SUM(points),0) AS s FROM score_events WHERE user_id=? AND source=?').get(id,source).s}
function useAbility(b){let user=rowUser(Number(b.user));ensure(user?.ability,'초능력 미배정');ensure(!user.ability_used,'이미 사용한 초능력입니다');let id=user.id,key=user.ability,target=Number(b.target),result='';let people=allUsers();let ids=people.map(x=>x.id);if(key==='echo'){
 ensure(allUsers().filter(x=>x.ability&&x.ability!=='echo').every(x=>x.ability_used),'에코는 다른 모든 초능력 사용 후 발동');ensure(allUsers().every(x=>x.bag_num!==null),'에코는 모든 가방 선택 후 발동');ensure(target!==id&&ids.includes(target),'교환 상대 선택');if(!isBlocked(target,id)){swapScores(id,target,'에코 복제 점수 교환');result=rowUser(target).name+'과 점수 교환'}else result='방벽에 막힘';
 } else if(key==='moira'){ensure(ids.includes(target)&&target!==id,'대상 선택');if(!isBlocked(target,id)){let amount=Math.min(2,Math.max(0,score(target)));addScore(target,-amount,'모이라 생체 흡수');addScore(id,amount,'모이라 생체 흡수');result=target+'에서 '+amount+'점 흡수'}else result='방벽에 막힘'
 } else if(key==='junkrat'){let roll=crypto.randomInt(1,7),points=[-2,-1,1,2,3,4][roll-1];addScore(id,points,'정크랫 주사위 '+roll);result='주사위 '+roll+' → '+points+'점'
 } else if(key==='symmetra'||key==='tracer'&&b.mode==='team'){
 let m=matchRow(String(b.match||''));ensure(m&&!m.completed,'시작 전 경기 선택');let t=JSON.parse(m.teams);let side=t.A.includes(id)?'A':t.B.includes(id)?'B':null;ensure(side,'해당 팀에 배정되지 않았습니다');let other=side==='A'?'B':'A';let pick=key==='tracer'?t[other][crypto.randomInt(t[other].length)]:target;ensure(t[other].includes(pick),'상대 팀 참가자 선택');t[side]=t[side].map(x=>x===id?pick:x);t[other]=t[other].map(x=>x===pick?id:x);saveTeams(m.id,t);result=m.label+' '+rowUser(pick).name+'과 팀 교환'
 } else if(key==='tracer'){
 let m=matchRow(String(b.match||''));ensure(m&&m.completed,'완료된 경기 선택');let ev=db.prepare("SELECT * FROM score_events WHERE user_id=? AND source=? ORDER BY id DESC LIMIT 1").get(id,'match:'+m.id);ensure(ev,'재추첨 가능한 봉투가 없습니다');let origPool=m.winner===(parseTeams(m.id).A.includes(id)?'A':'B')?WIN:LOSE;let ownTeam=parseTeams(m.id)[m.winner===(parseTeams(m.id).A.includes(id)?'A':'B')?m.winner:(m.winner==='A'?'B':'A')];let others=db.prepare('SELECT user_id,points FROM score_events WHERE source=? AND user_id!=?').all('match:'+m.id,id).filter(x=>ownTeam.includes(x.user_id));let pool=[...origPool];for(let o of others){let k=pool.indexOf(o.points);if(k>=0)pool.splice(k,1)}ensure(pool.length===1,'봉투 기록 불일치');let newPoint=pool[0]; // the original five unique envelopes leave only the old envelope; for reroll shuffle full deck independently
 newPoint=shuf(origPool)[0];addScore(id,newPoint-ev.points,'트레이서 봉투 재추첨 ('+ev.points+'→'+newPoint+')');result=ev.points+'점 → '+newPoint+'점'
 } else if(key==='lucio'){
 let m=matchRow(String(b.match||''));ensure(m,'팀 경기 선택');let t=JSON.parse(m.teams),side=t.A.includes(id)?'A':t.B.includes(id)?'B':null;ensure(side,'경기 팀 미배정');for(let uid of t[side])addScore(uid,1,'루시우 분위기 전환');result=m.label+' '+side+'팀 전원 +1'
 } else if(key==='cassidy'){ensure(ids.includes(target)&&target!==id,'대상 선택');ensure(['win','lose'].includes(b.outcome),'가위바위보 결과 선택');let winner=b.outcome==='win'?id:target;addScore(winner,2,'캐서디 가위바위보 승리');result=rowUser(winner).name+' +2점'
 } else if(key==='sigma'){
 let include=b.includeSelf===true;let chosen=include?[id,shuf(ids.filter(x=>x!==id))[0]]:shuf(ids.filter(x=>x!==id)).slice(0,2);if(chosen.some(x=>x!==id&&isBlocked(x,id))){result='라인하르트 방벽에 막힘'}else{swapScores(chosen[0],chosen[1],'시그마 중력 붕괴');result=chosen.map(x=>rowUser(x).name).join(' ↔ ')+' 점수 교환'}
 } else if(key==='reinhardt')fail(400,'라인하르트는 자동 방어 또는 최종 +1점으로 사용됩니다');
 else if(key==='mercy'){let chosen=shuf(ids).slice(0,3);for(let x of chosen)addScore(x,1,'메르시 발키리');result=chosen.map(x=>rowUser(x).name).join(', ')+' 각 +1점'
 } else fail(400,'능력을 찾을 수 없습니다');
 abilityUsed(id,result);announce('✨ '+user.name+' · '+abilityOf(user)?.[1]+' 발동',result);log(user.name+' '+abilityOf(user)?.[1]+' 발동 '+result);return {ok:true,note:result};}
const server=http.createServer(async(req,res)=>{try{if(new URL(req.url,'http://local').pathname.startsWith('/api/'))await api(req,res);else serve(req,res)}catch(e){if(e.status!==401&&e.status!==403)console.error(e.message);response(res,e.status||400,{error:e.message||'서버 오류'})}});
server.listen(process.env.PORT||3000,'0.0.0.0',()=>console.log('LAST PICK http://localhost:'+(process.env.PORT||3000)));
