'use strict';
const $ = id => document.getElementById(id);
const c=$('preview'), ctx=c.getContext('2d');
const colors={gold:['#ffde76','#8d5e14'],silver:['#d9eaf4','#647d93'],bronze:['#e8ac72','#8c4c2d']};
const titles={trophy:'Gopher Trophy',badge:'Explorer Badge',key:'Portal Key'};
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
(async()=>{if(!window.atlasWallet?.getIdentity){$('walletStatus').textContent='Domain Atlas wallet bridge not detected.';return}try{const r=await window.atlasWallet.getIdentity();$('walletStatus').textContent=r?.allowed&&r?.publicKey?'Wallet identity available.':r?.allowed?'No active wallet identity.':'Wallet access not enabled for this page.'}catch{$('walletStatus').textContent='Wallet connection unavailable.'}})();
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
