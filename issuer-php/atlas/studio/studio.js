'use strict';
const $ = id => document.getElementById(id);
const c=$('preview'), ctx=c.getContext('2d');
if(!ctx.roundRect)ctx.roundRect=function(x,y,w,h){this.rect(x,y,w,h)};
const palette={
 gold:{light:'#ffe9a3',mid:'#f2bd3b',dark:'#8a5a12',glow:'rgba(255,196,64,.34)'},
 silver:{light:'#f4f9fd',mid:'#c3d2de',dark:'#5d7387',glow:'rgba(170,200,235,.30)'},
 bronze:{light:'#f6c79a',mid:'#cf8650',dark:'#7d3f20',glow:'rgba(232,132,70,.32)'}
};
const titles={trophy:'Achievement Trophy',badge:'Explorer Badge',key:'Portal Key'};
// ---- creator options: ownership, expiry and labelled properties ----
// Limits default to the issuer's; checkIssuer() replaces them with what api.php?op=status reports.
const opts={giftable:true,expiryMin:3600,expiryMax:31536000,maxProps:6};
const KEY_RE=/^[a-z][a-z0-9_]{0,23}$/,pad=n=>String(n).padStart(2,'0');
const scopeValue=()=>document.querySelector('#scopePicker [aria-checked="true"]')?.dataset.value||'bound';
const localInput=d=>d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate())+'T'+pad(d.getHours())+':'+pad(d.getMinutes());
const fmtWhen=d=>d.toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short'});
// The window the page offers is a few minutes inside the issuer's, since the issuer re-checks at mint time.
function expiryWindow(){const now=Date.now();return {lo:new Date(Math.ceil((now+(opts.expiryMin+300)*1000)/60000)*60000),hi:new Date(Math.floor((now+(opts.expiryMax-300)*1000)/60000)*60000)}}
function expiryState(){
 if(!$('expiryOn').checked)return {value:null,problem:''};
 const raw=$('expiresAt').value,d=raw?new Date(raw):null;
 if(!d||isNaN(d))return {value:null,problem:'Pick an expiry date and time, or untick Expires.'};
 const w=expiryWindow();
 if(d<w.lo)return {value:null,problem:'Expiry must be after '+fmtWhen(w.lo)+'.'};
 if(d>w.hi)return {value:null,problem:'Expiry must be before '+fmtWhen(w.hi)+'.'};
 return {value:d.toISOString().slice(0,16)+':00Z',problem:''};
}
function propState(){
 const props={},problems=new Set(),seen=new Set();
 document.querySelectorAll('#props .prop-row').forEach(r=>{
  const k=r.querySelector('.pk').value.trim(),v=r.querySelector('.pv').value.trim();
  if(!k&&!v)return;
  if(!k||!v){problems.add('Each property needs both a name and a value.');return}
  if(!KEY_RE.test(k)){problems.add('Property names start with a letter and use a-z, 0-9 and _ only.');return}
  if(seen.has(k)){problems.add('Property name "'+k+'" is used twice.');return}
  seen.add(k);props[k]=v;
 });
 return {props,problems:[...problems]};
}
function design(){
 const d={schema:'atlas.asset-studio.design/0.1',template:$('template').value,name:$('assetName').value.trim().slice(0,64),description:$('description').value.trim().slice(0,240),finish:$('finish').value};
 if(scopeValue()==='local')d.tradeScope='local';
 const e=expiryState().value;if(e)d.expiresAt=e;
 const p=propState().props;if(Object.keys(p).length)d.properties=p;
 return d;
}
const formProblems=()=>[expiryState().problem,...propState().problems].filter(Boolean);

// ---- flat preview (also the fallback when WebGL or the model is unavailable) ----
function metal(x0,y0,x1,y1,p){const g=ctx.createLinearGradient(x0,y0,x1,y1);g.addColorStop(0,p.dark);g.addColorStop(.28,p.mid);g.addColorStop(.46,p.light);g.addColorStop(.62,p.mid);g.addColorStop(1,p.dark);return g;}
function sheen(path,alpha){ctx.save();ctx.globalAlpha=alpha;ctx.fillStyle='#fff';ctx.fill(path);ctx.restore();}
function paintFlat(d){
 const p=palette[d.finish]||palette.gold;ctx.clearRect(0,0,c.width,c.height);
 ctx.save();ctx.translate(250,196);
 const floor=ctx.createRadialGradient(0,150,4,0,150,150);floor.addColorStop(0,'rgba(0,0,0,.5)');floor.addColorStop(1,'rgba(0,0,0,0)');
 ctx.save();ctx.translate(0,152);ctx.scale(1,.2);ctx.fillStyle=floor;ctx.beginPath();ctx.arc(0,0,150,0,Math.PI*2);ctx.fill();ctx.restore();
 if(d.template==='trophy'){
  ctx.fillStyle=metal(-95,0,95,0,p);ctx.beginPath();ctx.roundRect(-95,126,190,26,6);ctx.fill();
  ctx.fillStyle=metal(-70,0,70,0,{...p,mid:p.dark,light:p.mid});ctx.beginPath();ctx.roundRect(-70,106,140,24,5);ctx.fill();
  ctx.fillStyle=metal(-17,0,17,0,p);ctx.beginPath();ctx.moveTo(-17,104);ctx.quadraticCurveTo(-8,70,-26,52);ctx.lineTo(26,52);ctx.quadraticCurveTo(8,70,17,104);ctx.closePath();ctx.fill();
  ctx.strokeStyle=metal(-130,0,130,0,p);ctx.lineWidth=15;ctx.lineCap='round';
  ctx.beginPath();ctx.moveTo(-84,-96);ctx.bezierCurveTo(-148,-96,-142,-6,-68,14);ctx.stroke();
  ctx.beginPath();ctx.moveTo(84,-96);ctx.bezierCurveTo(148,-96,142,-6,68,14);ctx.stroke();
  const cup=new Path2D();cup.moveTo(-96,-124);cup.lineTo(96,-124);cup.bezierCurveTo(96,-30,66,38,0,58);cup.bezierCurveTo(-66,38,-96,-30,-96,-124);cup.closePath();
  ctx.fillStyle=metal(-96,0,96,0,p);ctx.fill(cup);
  const rim=ctx.createLinearGradient(0,-124,0,-100);rim.addColorStop(0,p.light);rim.addColorStop(1,p.mid);ctx.fillStyle=rim;ctx.beginPath();ctx.roundRect(-100,-130,200,16,8);ctx.fill();
  const streak=new Path2D();streak.moveTo(-70,-108);streak.lineTo(-48,-108);streak.bezierCurveTo(-52,-36,-36,6,-14,34);streak.bezierCurveTo(-52,12,-72,-40,-70,-108);streak.closePath();sheen(streak,.42);
  const star=new Path2D();for(let i=0;i<10;i++){const a=i*Math.PI/5-Math.PI/2,r=i%2?17:40;star.lineTo(Math.cos(a)*r,-52+Math.sin(a)*r)}star.closePath();
  const sg=ctx.createLinearGradient(0,-92,0,-12);sg.addColorStop(0,p.dark);sg.addColorStop(1,p.mid);ctx.fillStyle=sg;ctx.fill(star);ctx.strokeStyle=p.light;ctx.globalAlpha=.55;ctx.lineWidth=1.5;ctx.lineJoin='round';ctx.stroke(star);ctx.globalAlpha=1;
 } else if(d.template==='badge'){
  ctx.translate(0,-6);
  const burst=new Path2D();for(let i=0;i<32;i++){const a=i*Math.PI/16-Math.PI/2,r=i%2?104:126;burst.lineTo(Math.cos(a)*r,Math.sin(a)*r)}burst.closePath();
  ctx.save();ctx.shadowColor='rgba(0,0,0,.45)';ctx.shadowBlur=22;ctx.shadowOffsetY=10;ctx.fillStyle=metal(-126,-126,126,126,p);ctx.fill(burst);ctx.restore();
  ctx.fillStyle=metal(126,-126,-126,126,p);ctx.beginPath();ctx.arc(0,0,96,0,Math.PI*2);ctx.fill();
  const face=ctx.createRadialGradient(-20,-28,6,0,0,82);face.addColorStop(0,'#2a3a52');face.addColorStop(1,'#0e1626');ctx.fillStyle=face;ctx.beginPath();ctx.arc(0,0,82,0,Math.PI*2);ctx.fill();
  ctx.strokeStyle=p.mid;ctx.lineWidth=2.5;ctx.globalAlpha=.8;ctx.beginPath();ctx.arc(0,0,70,0,Math.PI*2);ctx.stroke();ctx.globalAlpha=1;
  const star=new Path2D();for(let i=0;i<8;i++){const a=i*Math.PI/4-Math.PI/2,r=i%2?16:50;star.lineTo(Math.cos(a)*r,Math.sin(a)*r)}star.closePath();
  ctx.fillStyle=metal(-50,-50,50,50,p);ctx.fill(star);
  ctx.save();ctx.strokeStyle='rgba(255,255,255,.5)';ctx.lineWidth=4;ctx.lineCap='round';ctx.beginPath();ctx.arc(0,0,100,Math.PI*1.08,Math.PI*1.42);ctx.stroke();ctx.restore();
 } else {
  ctx.translate(-16,-20);ctx.rotate(-.5);
  ctx.save();ctx.shadowColor='rgba(0,0,0,.45)';ctx.shadowBlur=18;ctx.shadowOffsetY=8;
  ctx.strokeStyle=metal(-90,-90,90,90,p);ctx.lineWidth=30;ctx.beginPath();ctx.arc(0,-62,50,0,Math.PI*2);ctx.stroke();
  ctx.fillStyle=metal(-14,0,14,0,p);ctx.beginPath();ctx.roundRect(-14,-14,28,176,9);ctx.fill();
  ctx.beginPath();ctx.roundRect(14,98,44,18,5);ctx.roundRect(14,132,32,18,5);ctx.fill();ctx.restore();
  ctx.strokeStyle='rgba(255,255,255,.45)';ctx.lineWidth=4;ctx.lineCap='round';ctx.beginPath();ctx.arc(0,-62,62,Math.PI*1.1,Math.PI*1.45);ctx.stroke();
  ctx.fillStyle='rgba(255,255,255,.35)';ctx.fillRect(-9,2,4,150);
 }
 ctx.restore();
}

// ---- 3D preview ----
const stage=$('stage'),viewer=(window.AtlasModelViewer&&location.protocol!=='file:')?window.AtlasModelViewer.create($('model')):null;
let mode=viewer?'3d':'flat',modelState='idle',loadToken=0;
function showMode(next){
 mode=next;const three=mode==='3d'&&viewer&&modelState==='ready';
 $('model').hidden=!three;c.hidden=three;stage.dataset.mode=three?'3d':'flat';
 $('viewTabs').querySelectorAll('button').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.mode===(three?'3d':'flat'))));
 $('rotateBtn').hidden=$('resetBtn').hidden=!three;$('stageHint').hidden=!three;
}
function stageNote(text){$('stageNote').textContent=text||'';$('stageNote').hidden=!text}
async function loadModel(){
 if(!viewer){modelState='unavailable';stageNote(location.protocol==='file:'?'3D preview needs the hosted Studio page.':'3D preview is not available in this browser.');showMode('flat');$('viewTabs').hidden=true;return}
 const token=++loadToken,t=$('template').value;modelState='loading';stageNote('Loading 3D model…');
 try{await viewer.load('/assets/studio/'+t+'.glb',{standUp:t!=='trophy'});if(token!==loadToken)return;viewer.setFinish($('finish').value);modelState='ready';stageNote('');showMode(mode==='flat'&&$('viewTabs').dataset.chosen==='flat'?'flat':'3d')}
 catch(error){if(token!==loadToken)return;modelState='failed';stageNote('3D model unavailable; showing the flat preview.');showMode('flat')}
}

function syncPickers(d){
 document.querySelectorAll('#templateTiles [data-value]').forEach(b=>{const on=b.dataset.value===d.template;b.setAttribute('aria-checked',String(on));b.tabIndex=on?0:-1});
 document.querySelectorAll('#finishSwatches [data-value]').forEach(b=>{const on=b.dataset.value===d.finish;b.setAttribute('aria-checked',String(on));b.tabIndex=on?0:-1});
 stage.style.setProperty('--glow',(palette[d.finish]||palette.gold).glow);
 $('nameCount').textContent=$('assetName').value.length+'/64';$('descCount').textContent=$('description').value.length+'/240';
}
function paint(){
 const d=design();paintFlat(d);syncPickers(d);
 if(viewer&&modelState==='ready')viewer.setFinish(d.finish);
 $('previewName').textContent=d.name||titles[d.template];$('previewDescription').textContent=d.description;$('json').textContent=JSON.stringify(d,null,2);
 renderFacts(d);
 const problems=formProblems();$('formProblem').hidden=!problems.length;$('formProblem').textContent=problems[0]||'';
 $('propCount').textContent=$('props').children.length+'/'+opts.maxProps;$('addProp').disabled=$('props').children.length>=opts.maxProps;
 refreshMintButton();
}
function renderFacts(d){
 const items=[['scope',d.tradeScope==='local'?'Giftable on this domain':'Locked to your wallet'],['expiry',d.expiresAt?'Expires '+fmtWhen(new Date(d.expiresAt)):'No expiry']];
 Object.entries(d.properties||{}).forEach(([k,v])=>items.push(['prop',k.replace(/_/g,' ')+': '+v]));
 $('facts').replaceChildren(...items.map(([kind,text])=>{const li=document.createElement('li');li.className='fact fact-'+kind;li.textContent=text;return li}));
}
function applyOptions(){
 const gift=document.querySelector('#scopePicker [data-value="local"]');
 gift.disabled=!opts.giftable;gift.title=opts.giftable?'':'This issuer has not enabled giftable assets';
 if(!opts.giftable&&scopeValue()==='local')setScope('bound');
 const w=expiryWindow();$('expiresAt').min=localInput(w.lo);$('expiresAt').max=localInput(w.hi);
 $('expiryHint').textContent='Your local time. Earliest '+fmtWhen(w.lo)+', latest '+fmtWhen(w.hi)+'.';
}
function setScope(value){document.querySelectorAll('#scopePicker [data-value]').forEach(b=>{const on=b.dataset.value===value;b.setAttribute('aria-checked',String(on));b.tabIndex=on?0:-1});paint()}
function addProp(k='',v=''){
 if($('props').children.length>=opts.maxProps)return;
 const row=document.createElement('div');row.className='prop-row';
 row.innerHTML='<input class="pk" maxlength="24" placeholder="name" aria-label="Property name" autocomplete="off" spellcheck="false"><input class="pv" maxlength="64" placeholder="value" aria-label="Property value" autocomplete="off"><button type="button" class="prop-remove" aria-label="Remove property">\u00d7</button>';
 const pk=row.querySelector('.pk'),pv=row.querySelector('.pv');pk.value=k;pv.value=v;
 pk.addEventListener('input',()=>{pk.value=pk.value.toLowerCase().replace(/[\s-]+/g,'_').replace(/[^a-z0-9_]/g,'');paint()});
 pv.addEventListener('input',paint);
 row.querySelector('.prop-remove').addEventListener('click',()=>{row.remove();paint()});
 $('props').append(row);paint();return pk;
}
['assetName','description','finish'].forEach(id=>$(id).addEventListener('input',paint));
$('template').addEventListener('change',()=>{$('assetName').value=titles[$('template').value];paint();loadModel()});
// The tile and swatch groups drive the underlying selects, which stay the source of the design values.
function pick(groupId,selectId,value){const s=$(selectId);if(s.value===value)return;s.value=value;s.dispatchEvent(new Event(selectId==='template'?'change':'input',{bubbles:true}))}
[['templateTiles','template'],['finishSwatches','finish']].forEach(([groupId,selectId])=>{
 const group=$(groupId),items=()=>[...group.querySelectorAll('[data-value]')];
 group.addEventListener('click',e=>{const b=e.target.closest('[data-value]');if(b){pick(groupId,selectId,b.dataset.value);b.focus()}});
 group.addEventListener('keydown',e=>{
  const list=items(),i=list.indexOf(document.activeElement);if(i<0)return;
  const step={ArrowRight:1,ArrowDown:1,ArrowLeft:-1,ArrowUp:-1}[e.key];if(!step)return;
  e.preventDefault();const next=list[(i+step+list.length)%list.length];pick(groupId,selectId,next.dataset.value);next.focus();
 });
});
$('scopePicker').addEventListener('click',e=>{const b=e.target.closest('[data-value]');if(b&&!b.disabled){setScope(b.dataset.value);b.focus()}});
$('scopePicker').addEventListener('keydown',e=>{
 const list=[...document.querySelectorAll('#scopePicker [data-value]')].filter(b=>!b.disabled),i=list.indexOf(document.activeElement),step={ArrowRight:1,ArrowDown:1,ArrowLeft:-1,ArrowUp:-1}[e.key];
 if(i<0||!step)return;e.preventDefault();const next=list[(i+step+list.length)%list.length];setScope(next.dataset.value);next.focus();
});
$('expiryOn').addEventListener('change',()=>{
 const on=$('expiryOn').checked;$('expiresAt').disabled=!on;
 if(on&&!$('expiresAt').value){const w=expiryWindow();$('expiresAt').value=localInput(new Date(Math.min(Math.max(Date.now()+7*86400e3,w.lo.getTime()),w.hi.getTime())))}
 paint();
});
$('expiresAt').addEventListener('input',paint);
$('addProp').addEventListener('click',()=>{const pk=addProp();if(pk)pk.focus()});
$('viewTabs').addEventListener('click',e=>{const b=e.target.closest('button[data-mode]');if(!b)return;$('viewTabs').dataset.chosen=b.dataset.mode;showMode(b.dataset.mode)});
$('rotateBtn').addEventListener('click',()=>{if(!viewer)return;const on=!viewer.autoRotate;viewer.setAutoRotate(on);$('rotateBtn').setAttribute('aria-pressed',String(on))});
$('resetBtn').addEventListener('click',()=>viewer&&viewer.resetView());
if(viewer)$('rotateBtn').setAttribute('aria-pressed',String(viewer.autoRotate));
$('copy').addEventListener('click',async()=>{try{await navigator.clipboard.writeText(JSON.stringify(design(),null,2));$('message').textContent='Design copied.'}catch{$('message').textContent='Clipboard unavailable; select the JSON below.'}});
$('download').addEventListener('click',()=>{const blob=new Blob([JSON.stringify(design(),null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='atlas-asset-design.json';a.click();URL.revokeObjectURL(url);$('message').textContent='Design downloaded (not a minted asset).'});
let walletKey=null,mintEnabled=false,minting=false;
function refreshMintButton(){const bad=formProblems().length>0;$('mint').disabled=minting||bad||!(walletKey&&mintEnabled);$('mint').title=bad?'Fix the highlighted option first':walletKey?(mintEnabled?'':'Minting is not enabled on this issuer'):'Connect a Domain Atlas wallet identity first';}
async function postJson(op,body){
  const response=await fetch('api.php?op='+op,{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',cache:'no-store',body:JSON.stringify(body)});
  let json=null;try{json=await response.json()}catch{}
  return {status:response.status,json};
}
// The bridge can answer 'not allowed' simply because the extension had not attached yet when the page
// loaded, so a missing identity is re-checked a few times and again whenever the tab regains focus.
let checking=false;
async function checkWallet(){
 if(checking||walletKey)return;checking=true;
 try{
  if(!window.atlasWallet?.getIdentity){$('walletStatus').textContent='Domain Atlas wallet bridge not detected.';return}
  for(let attempt=0;attempt<4&&!walletKey;attempt++){
   try{const r=await window.atlasWallet.getIdentity();walletKey=r?.allowed&&r?.publicKey?r.publicKey:null;$('walletStatus').textContent=walletKey?'Wallet identity available.':r?.allowed?'No active wallet identity.':'Wallet access not enabled for this page.';if(r?.allowed)break}
   catch{$('walletStatus').textContent='Wallet connection unavailable.'}
   if(!walletKey)await new Promise(ok=>setTimeout(ok,1200));
  }
 }finally{checking=false;refreshMintButton()}
}
async function checkIssuer(){
 try{if(location.protocol!=='file:'){const s=await (await fetch('api.php?op=status',{cache:'no-store'})).json();mintEnabled=s.mintEnabled===true;const o=s.options;if(o){opts.giftable=o.giftable!==false;if(Number.isInteger(o.expiryMinSeconds))opts.expiryMin=o.expiryMinSeconds;if(Number.isInteger(o.expiryMaxSeconds))opts.expiryMax=o.expiryMaxSeconds;if(Number.isInteger(o.maxProperties))opts.maxProps=o.maxProperties}}}catch{}
 applyOptions();paint();
}
window.addEventListener('focus',checkWallet);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)checkWallet()});
checkIssuer();checkWallet();

// Mint to the wallet: the issuer hands out a short-lived challenge for exactly this design and wallet key,
// the wallet shows the request and signs it only if the visitor approves, the issuer verifies that signature
// and signs the credential, and the wallet's own offer flow receives it. Nothing here can change what is
// signed: the request to sign comes from the issuer and the credential is checked before it is offered.
async function mintToWallet(){
  const problem=formProblems()[0];if(problem){$('message').textContent=problem;return}
  if(minting)return;minting=true;refreshMintButton();
  const say=t=>{$('message').textContent=t};
  try{
    say('Asking the issuer for a mint challenge…');
    const ch=await postJson('challenge',{design:design(),recipient:walletKey});
    if(ch.status!==200||!ch.json?.ok)return say('The issuer refused the design: '+String(ch.json?.error||ch.status));
    say('Approve the request in your Domain Atlas wallet. It shows exactly what will be minted.');
    const sig=await window.atlasWallet.requestSignature(ch.json.signRequest);
    if(!sig||sig.allowed!==true)return say('This page is not permitted to request mint signatures from your wallet.');
    if(!sig.result)return say('The signature request was declined or timed out. Nothing was minted.');
    say('Wallet approved. Asking the issuer to mint…');
    const body={design:ch.json.design,nonce:ch.json.nonce,proof:sig.result};
    let res=null;
    for(let attempt=0;attempt<3&&!res;attempt++){
      try{
        const r=await postJson('mint',body);
        if(r.status===503||r.status===502||r.status===504){await new Promise(ok=>setTimeout(ok,1500));continue}
        res=r;
      }catch{await new Promise(ok=>setTimeout(ok,1500))}
    }
    // The same request can be repeated safely: the issuer answers a repeat with the original credential.
    if(!res)return say('The issuer did not answer. Your request is safe to repeat: press Mint again within two minutes to retrieve the result.');
    if(res.status!==200||!res.json?.ok)return say('Mint refused: '+String(res.json?.error||res.status));
    const cred=res.json.credential;
    if(!cred||cred.credential!=='domain-atlas-asset/1.0'||cred.asset?.class!=='atlas.demo.studio.collectible'||cred.owner?.publicKey!==walletKey||!cred.signature)return say('The issuer returned something that is not your credential, so it was not offered to the wallet.');
    const offer=await window.atlasWallet.offerAsset(cred);
    if(!offer||offer.allowed!==true)return say('Minted, but this page is not permitted to offer that asset class to your wallet.');
    if(!offer.result)return say('Minted, but the wallet offer was declined or timed out. Press Mint again to retrieve it.');
    say(offer.result.claimed?'Added to your wallet. The wallet verified the issuer signature.':'Offered to your wallet. Open its pending offers and Claim it: the wallet checks the issuer signature itself before adding it.');
  }catch(error){say('Mint failed: '+String(error?.message||'network error'))}
  finally{minting=false;refreshMintButton()}
}
$('mint').addEventListener('click',mintToWallet);
applyOptions();paint();
showMode(mode);
loadModel();

$('validate').addEventListener('click',async()=>{
  const problem=formProblems()[0];if(problem){$('message').textContent=problem;return}
  const button=$('validate');button.disabled=true;
  $('message').textContent='Checking design with PHP…';
  try {
    if(location.protocol==='file:') throw new Error('PHP validation needs the hosted Studio page. Local file previews still work.');
    const response=await fetch('api.php?op=validate',{
      method:'POST',headers:{'Content-Type':'application/json'},
      credentials:'same-origin',cache:'no-store',
      body:JSON.stringify(design())
    });
    const result=await response.json();
    if(result.ok && response.ok){
      $('message').textContent='PHP design validation passed. This is a design preview, not a minted asset.';
    } else {
      $('message').textContent='Design rejected: '+String(result.error||'validation-failed');
    }
  } catch(error) {
    $('message').textContent='Validation unavailable: '+String(error.message||'network error');
  } finally {button.disabled=false;}
});
