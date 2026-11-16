// Select only official options. Recording a click is not proof of long-term trust.
const trustedName=/^(信任(?:此|该|当前)?(?:设备|浏览器)(?:[（(]?\s*\d+\s*(?:天|日)[）)]?)?|记住(?:此|该|当前)?(?:设备|浏览器)|信任|Trust|Trust this device|Remember this device)$/i;
const onceName=/^(仅本次登录|Login this time only)$/i;
const navigationRace=e=>/Execution context was destroyed|Navigation .*interrupted|net::ERR_ABORTED/i.test(String(e.message));
async function chooseTrustedDevice(page,{preferTrust=process.env.SCHOOL_PREFER_TRUSTED_DEVICE!=='false',onChoice=()=>{}}={}){
 if(preferTrust){
  const trusted=page.getByRole('button',{name:trustedName}).first();
  if(await trusted.isVisible().catch(()=>false)){
   if(trusted.isEnabled&&!(await trusted.isEnabled()))return false;
   try{await trusted.click({timeout:5000})}catch(e){if(!navigationRace(e))throw e}
   await onChoice('trust');return true;
  }
  for(const role of ['checkbox','radio']){
   const option=page.getByRole(role,{name:trustedName}).first();if(!await option.isVisible().catch(()=>false))continue;
   if(option.isEnabled&&!(await option.isEnabled()))return false;
   const checked=await option.isChecked();if(!checked)await option.setChecked(true);
   const confirm=page.getByRole('button',{name:/^(确定|确认|继续|Confirm|Continue)$/i}).first();
   if(await confirm.isVisible().catch(()=>false)){try{await confirm.click({timeout:5000})}catch(e){if(!navigationRace(e))throw e}await onChoice('trust');return true}
   return !checked;
  }
 }
 const once=page.getByRole('button',{name:onceName}).first();
 if(await once.isVisible().catch(()=>false)){await once.click({timeout:5000});await onChoice('once');return true}
 return false;
}
module.exports={chooseTrustedDevice};
