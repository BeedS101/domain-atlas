'use strict';
const $ = id => document.getElementById(id);
const c=$('preview'), ctx=c.getContext('2d');
const colors={gold:['#ffde76','#8d5e14'],silver:['#d9eaf4','#647d93'],bronze:['#e8ac72','#8c4c2d']};
const titles={trophy:'Achievement Trophy',badge:'Explorer Badge',key:'Portal Key'};
function design(){return {schema:'atlas.asset-studio.design/0.1',template:$('template').value,name:$('assetName').value.trim().slice(0,64),description:$('description').value.trim().slice(0,240),finish:$('finish').value};}
function paint(){
 const d=design(),[light,dark]=colors[d.finish];ctx.clearRect(0,0,c.width,c.height);
 ctx.save();ctx.translate(250,200);ctx.shadowColor='#0009';ctx.shadowBlur=25;ctx.fillStyle=dark;
 if(d.template==='trophy'){
 ctx.fillRect(-18,65,36,70);ctx.fillRect(-85,125,170,22);ctx.fillStyle=light;
 ctx.beginPath();ctx.moveTo(-90,-120);ctx.lineTo(90,-120);ctx.lineTo(65,36);ctx.quadraticCurveTo(0,100,-65,36);ctx.closePath();ctx.fill();
 ctx.fillRect(-115,-110,25,80);ctx.fillRect(90,-110,25,80);ctx.fillStyle=dark;ctx.font='bold 76px serif';ctx.textAlign='center';ctx.fillText('★',0,-8);
 } else if(d.template==='badge'){
 ctx.fillStyle=light;ctx.beginPath();for(let i=0;i<12;i++){const a=i*Math.PI/6-Math.PI/2,r=i%2?88:120;ctx.lineTo(Math.cos(a)*r,Math.sin(a)*r)}ctx.closePath();ctx.fill();
 ctx.fillStyle=dark;ctx.beginPath();ctx.arc(0,0,75,0,Math.PI*2);ctx.fill();ctx.fillStyle=light;ctx.font='bold 84px serif';ctx.textAlign='center';ctx.fillText('✦',0,30);
 } else {
 ctx.strokeStyle=light;ctx.lineWidth=26;ctx.beginPath();ctx.arc(-25,-45,65,0,Math.PI*2);ctx.moveTo(13,0);ctx.lineTo(105,106);ctx.stroke();
 ctx.fillStyle=light;ctx.fillRect(78,75,20,52);ctx.fillRect(102,92,20,36);
 }ctx.restore();
 $('previewName').textContent=d.name||titles[d.template];$('previewDescription').textContent=d.description;$('json').textContent=JSON.stringify(d,null,2);
}
['template','assetName','description','finish'].forEach(id=>$(id).addEventListener('input',paint));
$('template').addEventListener('change',()=>{$('assetName').value=titles[$('template').value];paint()});
$('copy').addEventListener('click',async()=>{try{await navigator.clipboard.writeText(JSON.stringify(design(),null,2));$('message').textContent='Design copied.'}catch{$('message').textContent='Clipboard unavailable; select the JSON below.'}});
$('download').addEventListener('click',()=>{const blob=new Blob([JSON.stringify(design(),null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='atlas-asset-design.json';a.click();URL.revokeObjectURL(url);$('message').textContent='Design downloaded (not a minted asset).'});
let walletKey=null,mintEnabled=false,minting=false;
function refreshMintButton(){$('mint').disabled=minting||!(walletKey&&mintEnabled);$('mint').title=walletKey?(mintEnabled?'':'Minting is not enabled on this issuer'):'Connect a Domain Atlas wallet identity first';}
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
 try{if(location.protocol!=='file:'){const s=await (await fetch('api.php?op=status',{cache:'no-store'})).json();mintEnabled=s.mintEnabled===true}}catch{}
 refreshMintButton();
}
window.addEventListener('focus',checkWallet);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)checkWallet()});
checkIssuer();checkWallet();

// Mint to the wallet: the issuer hands out a short-lived challenge for exactly this design and wallet key,
// the wallet shows the request and signs it only if the visitor approves, the issuer verifies that signature
// and signs the credential, and the wallet's own offer flow receives it. Nothing here can change what is
// signed: the request to sign comes from the issuer and the credential is checked before it is offered.
async function mintToWallet(){
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
paint();

$('validate').addEventListener('click',async()=>{
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
