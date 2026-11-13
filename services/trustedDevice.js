// Called only on the official ids.hit.edu.cn page. User preference never skips
// a challenge: this selects the school's own post-verification trust choice.
const trustedName=/^(信任此设备|信任该设备|信任当前设备|信任|Trust|记住此设备|记住该设备|Trust this device|Remember this device)$/i;
const onceName=/^(仅本次登录|Login this time only)$/i;
async function chooseTrustedDevice(page,{preferTrust=process.env.SCHOOL_PREFER_TRUSTED_DEVICE!=='false'}={}){
 const trusted=page.getByRole('button',{name:trustedName}).first();
 if(preferTrust&&await trusted.isVisible().catch(()=>false)){
  if(trusted.isEnabled&&!(await trusted.isEnabled()))return false;
  try{await trusted.click({timeout:5000});}catch(e){if(!/Execution context was destroyed|Navigation .*interrupted|net::ERR_ABORTED/i.test(String(e.message)))throw e;}
  return true;
 }
 const once=page.getByRole('button',{name:onceName}).first();
 if(await once.isVisible().catch(()=>false)){await once.click({timeout:5000});return true;}
 return false;
}
module.exports={chooseTrustedDevice};
