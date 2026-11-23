// Bench Chrome ownership: fail closed on other/ambiguous profiles, and clean only admitted browser PIDs.
/** Parse ps pid/ucomm/command columns: kernel process name separates Chrome from wrappers and helpers. */
export function chromeCleanupPlan(ps, profile) {
  const owned = [];
  const blocked = [];
  for (const line of ps.split('\n')) {
    const match = /^\s*(\d+)\s+Google Chrome\s+(\/.*)$/.exec(line);
    if (!match) continue;
    const executable = /^\/.*\/Google Chrome\.app\/Contents\/MacOS\/Google Chrome(?:\s+(.*))?$/.exec(match[2]);
    const args = executable?.[1] ?? '';
    const flags = [...args.matchAll(/(?:^|\s)--user-data-dir=([^]*?)(?=\s--|$)/g)];
    const actual = flags.length === 1 ? flags[0][1] : null;
    if (profile && actual === profile) owned.push(Number(match[1]));
    else blocked.push(`Chrome pid ${match[1]} uses ${actual && !actual.includes('://') ? actual : 'a default or ambiguous profile'}`);
  }
  return { owned, blocked };
}

/** JXA targets the admitted process by PID, never the application by name, which may select another instance. */
export function chromeCleanupScript(pids) {
  return `const se=Application('System Events');const left=[];
for(const pid of ${JSON.stringify(pids)}) {
 const found=se.processes.whose({unixId:pid})();if(!found.length)continue;
 const p=found[0];if(p.name()!=='Google Chrome'){left.push('Chrome pid '+pid+' changed owner');continue;}
 try {
  for(let round=0;round<3 && p.windows().length;round++) {
   for(const w of p.windows().reverse()) {
    for(const sheet of w.sheets()) {
     const buttons=sheet.buttons();
     const cancel=['Leave','Don’t Save',"Don't Save",'Cancel'].map(name=>buttons.find(b=>b.name()===name)).find(Boolean);
     if(cancel)cancel.click();
    }
    // beforeunload is its own AXDialog window with Cancel and Leave and no close button, not a sheet
    const own=w.buttons();const label=b=>{try{return b.name();}catch(e){return '';}};
    const leave=['Leave','Don’t Save',"Don't Save"].map(name=>own.find(b=>label(b)===name)).find(Boolean);
    if(leave){leave.click();continue;}
    const close=own.find(b=>b.subrole()==='AXCloseButton');if(close)close.click();
   }
   delay(1);
  }
  if(p.windows().length)left.push('Chrome pid '+pid+' windows or dialogs remain');
 }catch(e){left.push('Chrome pid '+pid+' cleanup could not be verified');}
}
JSON.stringify(left)`;
}
