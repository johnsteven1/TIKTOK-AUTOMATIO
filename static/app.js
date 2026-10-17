const $ = (id) => document.getElementById(id);
let state = {profiles:[], comments:[], messages:[], logs:[], settings:{rotation_every:4}};
let toastTimer;
const pageMeta = {
 overview:["Overview","Manage profile reviews and outreach drafts."],
 browser:["TikTok browser","Sign in directly and review profiles in the live browser."],
 queue:["Username queue","Add profiles and track review status."],
 comments:["Comment templates","Manage reusable comment drafts and rotation."],
 messages:["Message templates","Manage direct-message drafts and rotation."],
 activity:["Activity history","Review recent changes made in this workspace."],
 settings:["Settings","Configure the local workflow."]
};
async function api(path, options={}) {
 const res = await fetch(path, {headers:{"Content-Type":"application/json"}, ...options});
 const data = await res.json().catch(()=>({error:"Unexpected server response"}));
 if(!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
 return data;
}
function showToast(message, error=false) {
 const el=$("toast"); el.textContent=message; el.classList.toggle("error",error); el.classList.add("show");
 clearTimeout(toastTimer); toastTimer=setTimeout(()=>el.classList.remove("show"),2800);
}
function esc(s="") { return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
function go(view) {
 document.querySelectorAll(".view").forEach(v=>v.classList.toggle("active",v.id===`view-${view}`));
 document.querySelectorAll(".nav-item").forEach(b=>b.classList.toggle("active",b.dataset.view===view));
 $("pageTitle").textContent=pageMeta[view][0]; $("pageSubtitle").textContent=pageMeta[view][1];
 if(view==="browser") { refreshBrowserStatus(); if(browserTimer) startScreenshotPolling(); }
 if(view==="comments") $("commentsInput").value=state.comments.join("\n");
 if(view==="messages") $("messagesInput").value=state.messages.join("\n");
 if(view==="settings") $("rotationSetting").value=state.settings.rotation_every || 4;
 window.scrollTo({top:0,behavior:"smooth"});
}
document.querySelectorAll(".nav-item").forEach(b=>b.addEventListener("click",()=>go(b.dataset.view)));
document.querySelectorAll("[data-goto]").forEach(b=>b.addEventListener("click",()=>go(b.dataset.goto)));
async function refresh() { state=await api("/api/state"); render(); }
function render() {
 const profiles=state.profiles||[], pending=profiles.filter(p=>p.status==="Pending"||p.status==="In review").length;
 $("statTotal").textContent=profiles.length; $("statPending").textContent=pending;
 $("statDone").textContent=profiles.filter(p=>p.status==="Completed").length;
 $("statTemplates").textContent=(state.comments||[]).length+(state.messages||[]).length;
 $("queueCount").textContent=`${profiles.length} PROFILE${profiles.length===1?"":"S"}`;
 $("previewCount").textContent=`${pending} pending`;
 const next=profiles.find(p=>p.status==="Pending"||p.status==="In review");
 $("previewName").textContent=next ? "@"+next.username : (profiles.length ? "Queue reviewed" : "No profile selected");
 $("previewStatus").textContent=next ? `${next.status} · Ready for your review` : "Add usernames to begin reviewing.";
 $("openNext").disabled=!next; $("openNext").dataset.username=next?.username||"";
 renderProfiles(); renderLogs();
}
function renderProfiles() {
 const body=$("profileRows");
 if(!state.profiles.length){body.innerHTML='<tr><td colspan="4" class="empty">Your queue is empty. Add usernames above.</td></tr>';return;}
 body.innerHTML=state.profiles.map(p=>`<tr>
 <td><div class="username-cell"><span class="avatar">${esc(p.username.slice(0,1).toUpperCase())}</span><div><b>@${esc(p.username)}</b><small>Added ${esc((p.added_at||"").replace("T"," ").slice(0,16))}</small></div></div></td>
 <td><select class="status-select" data-status="${esc(p.username)}" aria-label="Status for ${esc(p.username)}">${["Pending","In review","Completed","Skipped"].map(s=>`<option ${p.status===s?"selected":""}>${s}</option>`).join("")}</select></td>
 <td><div class="draft-status"><span class="${p.comment?"done-dot":""}">●</span> Comment ${p.comment?"saved":"—"}<br><span class="${p.message?"done-dot":""}">●</span> Message ${p.message?"saved":"—"}</div></td>
 <td><div class="actions"><button class="small-btn" data-open="${esc(p.username)}">Open ↗</button><button class="small-btn" data-draft="${esc(p.username)}">Drafts</button><button class="icon-btn" title="Remove profile" data-delete="${esc(p.username)}">×</button></div></td>
 </tr>`).join("");
 body.querySelectorAll("[data-status]").forEach(el=>el.addEventListener("change",async()=>{try{await api(`/api/profiles/${encodeURIComponent(el.dataset.status)}`,{method:"PATCH",body:JSON.stringify({status:el.value})});await refresh();showToast("Profile status updated.");}catch(e){showToast(e.message,true);}}));
 body.querySelectorAll("[data-open]").forEach(el=>el.addEventListener("click",()=>openProfile(el.dataset.open)));
 body.querySelectorAll("[data-draft]").forEach(el=>el.addEventListener("click",()=>draftFor(el.dataset.draft)));
 body.querySelectorAll("[data-delete]").forEach(el=>el.addEventListener("click",async()=>{if(!confirm(`Remove @${el.dataset.delete} from the queue?`))return;try{await api(`/api/profiles/${encodeURIComponent(el.dataset.delete)}`,{method:"DELETE"});await refresh();showToast("Profile removed.");}catch(e){showToast(e.message,true);}}));
}
function renderLogs() {
 const logs=state.logs||[];
 const html=logs.length?logs.map(l=>`<div class="log-item"><div class="log-mark">${l.status==="Completed"?"✓":"•"}</div><div class="log-copy"><b>${esc(l.action)} <span>${esc(l.username)}</span></b><p>${esc(l.detail||l.status)}</p></div><time>${esc((l.time||"").replace("T"," ").slice(0,16))}</time></div>`).join(""):'<div class="empty">No activity yet.</div>';
 $("recentLogs").innerHTML=html; $("allLogs").innerHTML=html;
}
async function addUsers(source,feedback) {
 try {const result=await api("/api/profiles",{method:"POST",body:JSON.stringify({usernames:$(source).value})});$(source).value="";if(feedback)$(feedback).textContent=`Added ${result.added} new profile(s).`;await refresh();showToast(`Added ${result.added} profile(s).`);}
 catch(e){if(feedback)$(feedback).textContent=e.message;showToast(e.message,true);}
}
$("quickAdd").addEventListener("click",()=>addUsers("quickUsernames"));
$("addProfiles").addEventListener("click",()=>addUsers("bulkUsernames","queueFeedback"));
async function saveTemplates(kind,inputId) {
 const items=$(inputId).value.split("\n").map(x=>x.trim()).filter(Boolean);
 try {state=(await api(`/api/templates/${kind}`,{method:"POST",body:JSON.stringify({items})})).state;render();showToast("Templates saved.");}
 catch(e){showToast(e.message,true);}
}
$("saveComments").addEventListener("click",()=>saveTemplates("comments","commentsInput"));
$("saveMessages").addEventListener("click",()=>saveTemplates("messages","messagesInput"));
async function preview(kind,target) {
 try {const r=await api(`/api/next-template/${kind}`,{method:"POST",body:"{}"});$(target).textContent=`“${r.template}” (template ${r.template_index+1}; use ${r.use_number})`;}
 catch(e){$(target).textContent=e.message;showToast(e.message,true);}
}
$("previewComment").addEventListener("click",()=>preview("comments","commentPreview"));
$("previewMessage").addEventListener("click",()=>preview("messages","messagePreview"));
$("saveSettings").addEventListener("click",async()=>{
 try {const r=await api("/api/settings",{method:"POST",body:JSON.stringify({rotation_every:Number($("rotationSetting").value)})});state.settings=r.settings;$("rotationComments").value=r.settings.rotation_every;$("rotationMessages").value=r.settings.rotation_every;showToast("Settings saved.");}
 catch(e){showToast(e.message,true);}
});
$("rotationComments").addEventListener("change",syncRotation);
$("rotationMessages").addEventListener("change",syncRotation);
async function syncRotation(e){$("rotationSetting").value=e.target.value;try{const r=await api("/api/settings",{method:"POST",body:JSON.stringify({rotation_every:Number(e.target.value)})});state.settings=r.settings;$("rotationComments").value=r.settings.rotation_every;$("rotationMessages").value=r.settings.rotation_every;showToast("Rotation updated.");}catch(err){showToast(err.message,true);}}
$("refreshLogs").addEventListener("click",async()=>{await refresh();showToast("Activity refreshed.");});
async function openProfile(username) {
 await api(`/api/profiles/${encodeURIComponent(username)}`,{method:"PATCH",body:JSON.stringify({status:"In review"})});
 await api("/api/log",{method:"POST",body:JSON.stringify({username,action:"Open profile",status:"Started",detail:"Profile opened in a separate TikTok tab for manual review."})});
 await api("/api/browser/navigate",{method:"POST",body:JSON.stringify({username})});
 await refresh(); go("browser"); startScreenshotPolling(); showToast(`Opened @${username} in the live browser.`);
}
$("openNext").addEventListener("click",()=>{if($("openNext").dataset.username)openProfile($("openNext").dataset.username).catch(e=>showToast(e.message,true));});
async function draftFor(username) {
 const p=state.profiles.find(x=>x.username.toLowerCase()===username.toLowerCase()); if(!p)return;
 let comment=state.comments[0]||"", message=state.messages[0]||"";
 try { if(!p.comment && state.comments.length) comment=(await api("/api/next-template/comments",{method:"POST",body:"{}"})).template; if(!p.message && state.messages.length) message=(await api("/api/next-template/messages",{method:"POST",body:"{}"})).template; } catch(e) { showToast(e.message,true); return; }
 const commentDraft=prompt("Review/edit a comment draft for @"+username, p.comment||comment);
 if(commentDraft===null)return;
 const messageDraft=prompt("Review/edit a message draft for @"+username,p.message||message);
 if(messageDraft===null)return;
 try {await api(`/api/profiles/${encodeURIComponent(username)}`,{method:"PATCH",body:JSON.stringify({comment:commentDraft,message:messageDraft})});await api("/api/log",{method:"POST",body:JSON.stringify({username,action:"Save drafts",status:"Saved",detail:"Comment and message drafts saved for manual review."})});await refresh();showToast("Drafts saved. Nothing was sent.");}
 catch(e){showToast(e.message,true);}
}
$("resetData").addEventListener("click",async()=>{if(!confirm("Reset all profiles, templates, and activity? This cannot be undone."))return;try{await api("/api/reset",{method:"POST",body:"{}"});await refresh();go("overview");showToast("Workspace reset.");}catch(e){showToast(e.message,true);}});
refresh().then(()=>{
 $("commentsInput").value=state.comments.join("\n");$("messagesInput").value=state.messages.join("\n");
 $("rotationComments").value=state.settings.rotation_every||4;$("rotationMessages").value=state.settings.rotation_every||4;
}).catch(e=>showToast("Could not load workspace: "+e.message,true));


// Embedded browser: persistent Playwright profile stores the site's session locally.
let browserTimer=null, browserBusy=false;
async function refreshBrowserStatus(){
 try{
  const r=await api("/api/browser/status");
  $("browserBadge").textContent=r.running?"BROWSER RUNNING":"NOT CONNECTED";
  $("browserUrl").textContent=r.url||"TikTok browser not started";
  if(r.error) $("browserFeedback").textContent=r.error;
  if(r.running) startScreenshotPolling();
 }catch(e){$("browserFeedback").textContent=e.message;}
}
function ensureScreenshotPolling(){if(browserTimer)clearInterval(browserTimer);browserTimer=setInterval(()=>{if($("view-browser").classList.contains("active"))startScreenshotPolling();},1800);}
function startScreenshotPolling(){
 if(!browserTimer)ensureScreenshotPolling();
 if(!browserBusy){ browserBusy=true; (async()=>{try{const img=$("browserScreen");const r=await fetch(`/api/browser/screenshot?t=${Date.now()}`,{cache:"no-store"});if(!r.ok){const d=await r.json().catch(()=>({}));throw new Error(d.error||"Start the browser to show the screen.");}const blob=await r.blob();const url=URL.createObjectURL(blob);const old=img.dataset.objectUrl;img.src=url;img.dataset.objectUrl=url;img.hidden=false;$("browserPlaceholder").hidden=true;if(old)URL.revokeObjectURL(old);const u=r.headers.get("X-Browser-Url");if(u)$("browserUrl").textContent=u;$("browserBadge").textContent="LIVE VIEW";}catch(e){if($("browserScreen").hidden)$("browserFeedback").textContent=e.message;}finally{browserBusy=false;}})(); }
}
$("startBrowser").addEventListener("click",async()=>{const b=$("startBrowser");b.disabled=true;$("browserFeedback").textContent="Starting browser…";try{await api("/api/browser/start",{method:"POST",body:"{}"});$("browserFeedback").textContent="TikTok opened. Sign in directly in the live screen; session data is saved in the local browser profile.";$("browserBadge").textContent="LIVE VIEW";startScreenshotPolling();}catch(e){$("browserFeedback").textContent=e.message;showToast(e.message,true);}finally{b.disabled=false;}});
$("stopBrowser").addEventListener("click",async()=>{try{await api("/api/browser/stop",{method:"POST",body:"{}"});if(browserTimer){clearInterval(browserTimer);browserTimer=null;}$("browserBadge").textContent="STOPPED";$("browserUrl").textContent="Browser stopped";$("browserScreen").hidden=true;$("browserPlaceholder").hidden=false;$("browserPlaceholder").querySelector("p").textContent="Browser stopped. Your local browser profile remains saved.";$("browserFeedback").textContent="Browser closed. Your saved session profile was kept.";showToast("Browser stopped.");}catch(e){showToast(e.message,true);}});
$("refreshBrowser").addEventListener("click",()=>startScreenshotPolling());
$("browserScreen").addEventListener("click",async e=>{const img=e.currentTarget;const rect=img.getBoundingClientRect();const x=Math.round((e.clientX-rect.left)*(img.naturalWidth/rect.width));const y=Math.round((e.clientY-rect.top)*(img.naturalHeight/rect.height));try{await api("/api/browser/click",{method:"POST",body:JSON.stringify({x,y})});setTimeout(startScreenshotPolling,250);}catch(err){showToast(err.message,true);}});
$("typeBrowserText").addEventListener("click",async()=>{const input=$("browserText");if(!input.value)return;try{await api("/api/browser/type",{method:"POST",body:JSON.stringify({text:input.value})});input.value="";setTimeout(startScreenshotPolling,200);}catch(e){showToast(e.message,true);}});
document.querySelectorAll("[data-key]").forEach(b=>b.addEventListener("click",async()=>{try{await api("/api/browser/key",{method:"POST",body:JSON.stringify({key:b.dataset.key})});setTimeout(startScreenshotPolling,200);}catch(e){showToast(e.message,true);}}));
$("navigateBrowser").addEventListener("click",async()=>{const username=$("browserUsername").value.trim().replace(/^@/,"");try{await api("/api/browser/navigate",{method:"POST",body:JSON.stringify({username})});$("browserFeedback").textContent=username?`Opened @${username} for manual review.`:"Opened Google. Search for TikTok and sign in manually.";$("browserUsername").value="";$("browserBadge").textContent="LIVE VIEW";startScreenshotPolling();await refresh();}catch(e){$("browserFeedback").textContent=e.message;showToast(e.message,true);}});

// Action preferences are local dashboard preferences for bounded, one-at-a-time actions.
const actionPrefsKey = "tiktokWorkflowActionPrefs";
function loadActionPrefs(){
 try {
  const p=JSON.parse(localStorage.getItem(actionPrefsKey)||"{}");
  $("likeEnabled").checked=!!p.like;
  $("commentEnabled").checked=!!p.comment;
  $("messageEnabled").checked=!!p.message;
  $("actionDelay").value=Math.max(2,Math.min(120,Number(p.delay)||5));
  $("actionLimit").value=Math.max(1,Math.min(25,Number(p.limit)||5));
 } catch(e) {}
}
$("saveActionPrefs")?.addEventListener("click",()=>{
 const prefs={like:$("likeEnabled").checked,comment:$("commentEnabled").checked,message:$("messageEnabled").checked,
  delay:Math.max(2,Math.min(120,Number($("actionDelay").value)||5)),limit:Math.max(1,Math.min(25,Number($("actionLimit").value)||5))};
 $("actionDelay").value=prefs.delay;$("actionLimit").value=prefs.limit;
 localStorage.setItem(actionPrefsKey,JSON.stringify(prefs));
 const enabled=[prefs.like&&"likes",prefs.comment&&"comments",prefs.message&&"direct messages"].filter(Boolean);
 $("actionStatus").textContent=enabled.length?`${enabled.length} ACTION TYPE${enabled.length===1?"":"S"} ENABLED`:"ACTIONS DISABLED";
 showToast("Action preferences saved.");
});
loadActionPrefs();


// One-at-a-time, user-triggered automation on the currently open post/conversation. No queue/bulk loop.
let lastAssistedActionAt = 0;
const waitMs = ms => new Promise(resolve => setTimeout(resolve, ms));
async function runAssistedAction(action) {
 const prefs=JSON.parse(localStorage.getItem(actionPrefsKey)||"{}");
 const toggle={like:"like",comment:"comment",message:"message"}[action];
 if(!prefs[toggle]) { showToast(`Enable ${action} in Action controls first.`,true); return; }
 const text=$("actionText").value.trim();
 if(action!=="like"&&!text) { showToast("Enter the comment/message text first.",true); $("actionText").focus(); return; }
 const button=$({like:"runLike",comment:"prepareComment",message:"prepareMessage"}[action]);
 button.disabled=true;
 $("actionFeedback").textContent="Working…";
 try {
   const delayMs=Math.max(2,Math.min(120,Number(prefs.delay)||5))*1000;
   const remaining=lastAssistedActionAt ? delayMs-(Date.now()-lastAssistedActionAt) : 0;
   if(remaining>0){$("actionFeedback").textContent=`Waiting ${Math.ceil(remaining/1000)}s for your configured delay…`;await waitMs(remaining);}
   const r=await api("/api/browser/action",{method:"POST",body:JSON.stringify({action,text})});
   lastAssistedActionAt=Date.now();
   $("actionFeedback").textContent=`${r.status}: ${r.detail||"Action completed."}${r.action_count?` (${r.action_count}/${r.action_limit} this session)`:""}`;
   await refresh();
   showToast(r.status==="Already liked"?"Post already appears liked.":r.status==="Submitted"?"Action submitted.":"Like action completed.");
   startScreenshotPolling();
 } catch(e) {
   $("actionFeedback").textContent=e.message;
   showToast(e.message,true);
 } finally { button.disabled=false; }
}
$("runLike")?.addEventListener("click",()=>runAssistedAction("like"));
$("prepareComment")?.addEventListener("click",()=>runAssistedAction("comment"));
$("prepareMessage")?.addEventListener("click",()=>runAssistedAction("message"));
