/* FlagKan live push client (LIVE-001). One WebSocket to /api/live; the
   server pushes a "tick" after each cron run. Polling (60s, Worker REST, not
   the Durable Object) is ONLY the fallback: after 3 failed attempts, a
   refusal (close 4429), or no WebSocket support. While polling, the socket
   is retried no sooner than every 5 minutes. Keepalive = exactly "ping"
   every 25s (answered by the server runtime without waking anything). */
(function(root){
"use strict";
var PING_MS=25000,POLL_MS=60000,SLOW_MS=300000,MAX_FAILS=3,CAP_MS=30000,GAP_RESYNC_MS=120000,REFUSED=4429;
var TXT={en:{live:"live",reconnecting:"reconnecting…",polling:"updating every minute"},th:{live:"สด",reconnecting:"กำลังเชื่อมต่อใหม่…",polling:"อัปเดตทุกนาที"}};
function statusText(state,lang){var t=TXT[lang]||TXT.en;return t[state]||TXT.en[state]||""}
/* exponential backoff with jitter, capped (attempt 0 -> ~1s) */
function backoff(n,rnd){var r=(typeof rnd==="number")?rnd:Math.random();var base=Math.min(CAP_MS,1000*Math.pow(2,Math.max(0,n)));return Math.round(base*(0.5+0.5*r))}
/* upsert rows by mint into list IN PLACE; new mints go on top in tick order.
   accept(row) (optional) gates NEW mints only (e.g. skip old coins outside the loaded window).
   Returns {changed:[mints], added:n}. Ignores rows without a string mint. */
function upsertRows(list,rows,accept){var idx={},i,changed=[],fresh=[],seen={};
for(i=0;i<list.length;i++){if(list[i]&&typeof list[i].mint==="string")idx[list[i].mint]=i}
for(i=0;i<(rows||[]).length;i++){var r=rows[i];if(!r||typeof r.mint!=="string"||!r.mint||seen[r.mint])continue;seen[r.mint]=1;
if(Object.prototype.hasOwnProperty.call(idx,r.mint)){list[idx[r.mint]]=r}else if(!accept||accept(r)){fresh.push(r)}else{continue}changed.push(r.mint)}
if(fresh.length)Array.prototype.splice.apply(list,[0,0].concat(fresh));
return {changed:changed,added:fresh.length}}
/* newest-first board order, same as /api/rounds (first_seen DESC, mint ASC) */
function byNewest(a,b){var d=(Number(b.first_seen)||0)-(Number(a.first_seen)||0);return d!==0?d:(a.mint<b.mint?-1:a.mint>b.mint?1:0)}
/* accept predicate: new mint is inside the loaded newest-first window */
function inWindow(list,complete){var min=Infinity;for(var i=0;i<list.length;i++){var f=Number(list[i]&&list[i].first_seen);if(f<min)min=f}return function(r){return complete||!list.length||Number(r.first_seen)>=min}}
/* merge the tick's small proof summary into the page's full /api/proof object */
function mergeProof(full,summary){if(!summary||typeof summary!=="object")return full;var out=full&&typeof full==="object"?full:{};for(var k in summary){if(Object.prototype.hasOwnProperty.call(summary,k))out[k]=summary[k]}return out}
/* o: {onTick(evt), onStatus(state), poll(), resync()} */
function connect(o){
var ws=null,fails=0,pingT=null,retryT=null,pollT=null,polling=false,lastMsg=0,downAt=0,state="";
function status(s){if(s===state)return;state=s;try{o.onStatus&&o.onStatus(s)}catch(e){}}
function startPolling(){if(polling)return;polling=true;status("polling");pollT=setInterval(function(){try{o.poll&&o.poll()}catch(e){}},POLL_MS)}
function stopPolling(){if(!polling)return;polling=false;clearInterval(pollT);pollT=null}
function retry(ms){clearTimeout(retryT);retryT=setTimeout(open,ms)}
var WS=root.WebSocket;
if(typeof WS!=="function"){startPolling();return {state:function(){return state}}}
function open(){var url=(root.location.protocol==="https:"?"wss://":"ws://")+root.location.host+"/api/live";var opened=false,openedAt=0,sock;
try{sock=new WS(url)}catch(e){onFail(false,0);return}
ws=sock;
sock.onopen=function(){opened=true;openedAt=Date.now();fails=0;var wasPolling=polling;stopPolling();status("live");
clearInterval(pingT);pingT=setInterval(function(){try{if(sock.readyState===1)sock.send("ping")}catch(e){}},PING_MS);
if(wasPolling||(downAt&&Date.now()-downAt>GAP_RESYNC_MS)){try{o.resync&&o.resync()}catch(e){}}downAt=0};
sock.onmessage=function(ev){lastMsg=Date.now();var d=ev&&ev.data;if(typeof d!=="string"||d==="pong")return;var m;try{m=JSON.parse(d)}catch(e){return}
if(m&&m.type==="tick"){try{o.onTick&&o.onTick(m)}catch(e){}}};
sock.onerror=function(){};
sock.onclose=function(ev){clearInterval(pingT);pingT=null;if(ws===sock)ws=null;onFail(opened&&Date.now()-openedAt>5000,ev&&ev.code)}}
function onFail(wasOpen,code){if(!downAt)downAt=Date.now();
if(code===REFUSED){startPolling();retry(SLOW_MS+backoff(0)*10);return}
if(wasOpen){fails=0;if(!polling)status("reconnecting");retry(backoff(0));return}
fails++;
if(fails>=MAX_FAILS){startPolling();retry(SLOW_MS+backoff(fails)*2);return}
if(!polling)status("reconnecting");retry(backoff(fails))}
open();
return {state:function(){return state},lastMessageAt:function(){return lastMsg}}}
root.FlagLive={connect:connect,upsertRows:upsertRows,byNewest:byNewest,inWindow:inWindow,mergeProof:mergeProof,backoff:backoff,statusText:statusText,PING_MS:PING_MS,POLL_MS:POLL_MS,SLOW_MS:SLOW_MS,MAX_FAILS:MAX_FAILS,REFUSED:REFUSED};
})(typeof window!=="undefined"?window:globalThis);
