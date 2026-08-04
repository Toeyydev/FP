import { NextResponse } from "next/server";
import { auth } from "@/auth";

function ops(role?: string) { return role === "OPERATOR" || role === "ADMIN"; }

// GET — ops only. Admin console that re-renders every previously-saved job sheet
// and OVERWRITES its Drive PDF, so old sheets pick up the new Approved signature.
// Each sheet is rendered by the real print page (?auto=1) inside a hidden iframe,
// which saves via /api/jobsheet/drive (same-name overwrite; old copy goes to
// Drive Trash) and postMessages the result back. Sequential, with a Test-1 gate.
export async function GET() {
  const session = await auth();
  if (!ops(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Signature backfill</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
 body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#16201c;margin:0;background:#f6f5f2;font-size:14px}
 .wrap{max-width:720px;margin:0 auto;padding:20px 16px 60px}
 h1{color:#7e3a2c;font-size:20px;margin:6px 0}
 .note{background:#fbf4e8;border:1px solid #ecd9bf;color:#7e3a2c;border-radius:8px;padding:10px 12px;font-size:12.5px;line-height:1.5;margin:12px 0}
 .bar{height:8px;background:#e6e3dd;border-radius:6px;overflow:hidden;margin:12px 0}
 .bar>i{display:block;height:100%;width:0;background:#7e3a2c;transition:width .2s}
 .btn{background:#7e3a2c;color:#fff;border:none;border-radius:8px;padding:9px 14px;font-weight:600;cursor:pointer;font-size:13px;margin-right:8px}
 .btn.sec{background:#fff;color:#7e3a2c;border:1px solid #d8b9a6}
 .btn:disabled{opacity:.5;cursor:default}
 #status{margin:10px 0;font-weight:600}
 .row{display:flex;justify-content:space-between;gap:10px;padding:6px 8px;border-bottom:1px solid #eee;font-size:12.5px}
 .row .st{font-weight:700}
 #log{background:#fff;border:1px solid #e6e3dd;border-radius:8px;margin-top:12px;max-height:340px;overflow:auto}
 iframe{position:fixed;left:-9999px;top:0;width:820px;height:1200px;border:0}
</style></head><body><div class="wrap">
 <h1>Re-save job sheets to Drive (Approved signature)</h1>
 <div class="note">This re-renders each previously-saved job sheet and <b>overwrites</b> its Drive PDF with the signed version. The old copy is moved to <b>Google Drive Trash</b> (recoverable ~30 days), not hard-deleted. Deploy the signature change first, then run <b>Test 1</b> and check that PDF in Drive before <b>Run all</b>.</div>
 <div id="status">Loading…</div>
 <div class="bar"><i id="pbar"></i></div>
 <button class="btn sec" id="refreshBtn" onclick="load()">Refresh list</button>
 <button class="btn sec" id="testBtn" onclick="go(1)" disabled>Test 1</button>
 <button class="btn" id="runBtn" onclick="confirmRun()" disabled>Run all</button>
 <div id="log"></div>
 <iframe id="frame" title="renderer"></iframe>
</div>
<script>
 var LIST=[], busy=false;
 var statusEl=document.getElementById("status"), barEl=document.getElementById("pbar"), logEl=document.getElementById("log");
 var frame=document.getElementById("frame");
 function esc(s){return String(s==null?"":s).replace(/[&<>]/g,function(c){return c==="&"?"&amp;":c==="<"?"&lt;":"&gt;";});}
 function setBtns(on){document.getElementById("testBtn").disabled=!on;document.getElementById("runBtn").disabled=!on;document.getElementById("refreshBtn").disabled=!on;}
 async function load(){
   setBtns(false); statusEl.textContent="Loading list…"; barEl.style.width="0";
   try{
     var r=await fetch("/api/jobsheet/backfill-list");
     var d=await r.json();
     if(!r.ok){ statusEl.textContent="Error: "+(d.error||r.status); return; }
     LIST=d.sheets||[];
     statusEl.textContent="Found "+LIST.length+" saved job sheet(s).";
     logEl.innerHTML=LIST.map(function(s,i){return '<div class="row" id="row'+i+'"><span>'+esc(s.ref)+' · '+esc(s.guideId)+' · '+esc(s.date)+' · slot '+s.slotIdx+'</span><b class="st" id="st'+i+'">–</b></div>';}).join("")||'<div class="row">No saved sheets found.</div>';
     setBtns(LIST.length>0);
   }catch(e){ statusEl.textContent="Error: "+((e&&e.message)||e); }
 }
 function runOne(i){
   return new Promise(function(resolve){
     var s=LIST[i], st=document.getElementById("st"+i); if(st){st.textContent="…";st.style.color="#b26a00";}
     var done=false, tmr;
     function finish(ok,msg){ if(done)return; done=true; window.removeEventListener("message",onMsg); clearTimeout(tmr);
       if(st){ st.textContent=ok?"saved ✓":("fail: "+(msg||"")); st.style.color=ok?"#1c7c3a":"#c0392b"; } resolve(ok); }
     function onMsg(ev){ var m=ev.data; if(!m||!m.fpBackfill)return; finish(!!(m.ok&&m.drive), m.error||(m.ok&&!m.drive?"drive not saved":"")); }
     window.addEventListener("message",onMsg);
     tmr=setTimeout(function(){ finish(false,"timeout"); },60000);
     frame.src="/api/jobsheet/pdf?guideId="+encodeURIComponent(s.guideId)+"&date="+encodeURIComponent(s.date)+"&slotIdx="+s.slotIdx+"&auto=1";
   });
 }
 async function go(limit){
   if(busy||!LIST.length)return; busy=true; setBtns(false);
   var n=limit?Math.min(limit,LIST.length):LIST.length, ok=0, fail=0;
   for(var i=0;i<n;i++){ var r=await runOne(i); r?ok++:fail++; barEl.style.width=Math.round((i+1)/n*100)+"%"; statusEl.textContent="Processed "+(i+1)+"/"+n+" — "+ok+" saved, "+fail+" failed."; await new Promise(function(res){setTimeout(res,800);}); }
   statusEl.textContent="Done. "+ok+" saved, "+fail+" failed"+(fail?" — originals are recoverable from Google Drive Trash.":".");
   busy=false; setBtns(true);
 }
 function confirmRun(){ if(confirm("Re-save ALL "+LIST.length+" job sheets to Drive? Old copies move to Drive Trash (recoverable). Make sure Test 1 looked right first.")) go(0); }
 load();
</script></body></html>`;
  return new NextResponse(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "private, no-store" } });
}
