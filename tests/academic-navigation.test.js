const {test}=require("node:test"),assert=require("node:assert/strict"),access=require("../services/academicAccess");
test("CAS自动跳转中断不立即判失败，也不重放一次性ticket",async()=>{
 let navigations=0,settled=0;
 const session={step:"connecting",page:{goto:async()=>{navigations++;throw Error("page.goto: net::ERR_ABORTED at callback")},waitForLoadState:async()=>{settled++},waitForTimeout:async()=>{}}};
 const result=await access.navigate(session,"http://jwts-hitwh-edu-cn.ivpn.hitwh.edu.cn:8118/loginCAS?ticket=fixture","cas_callback");
 assert.equal(result,false);assert.equal(navigations,1);assert.equal(settled,1);
 assert.notEqual(session.step,"ready");assert.equal(session.phase,"cas_callback");
});
test("连接拒绝等网络故障不能被当成普通跳转吞掉",async()=>{
 const session={page:{goto:async()=>{throw Error("net::ERR_CONNECTION_REFUSED")}}};
 await assert.rejects(access.navigate(session,"http://example.invalid","entry"),/ERR_CONNECTION_REFUSED/);
});
test("重复中断有上限，不产生无限重试",async()=>{
 const session={navigationRetries:5,page:{goto:async()=>{throw Error("net::ERR_ABORTED")}}};
 await assert.rejects(access.navigate(session,"http://example.invalid","entry"),e=>e.code==="ACADEMIC_NAVIGATION_INTERRUPTED");
});
test("普通页面跳转保持成功返回且记录阶段",async()=>{
 const session={page:{goto:async()=>{}}};
 assert.equal(await access.navigate(session,"http://example.invalid","vpn_portal"),true);
 assert.equal(session.phase,"vpn_portal");
});
test("识别SSO的目标服务，VPN未完成时不能抢先领取教务票据",()=>{
 assert.equal(access.ssoTarget("https://ids.hit.edu.cn/authserver/login?service="+encodeURIComponent("https://ivpn.hitwh.edu.cn/auth/cas_validate?entry_id=2")),"vpn");
 assert.equal(access.ssoTarget("https://ids.hit.edu.cn/authserver/login?service="+encodeURIComponent("http://jwts.hitwh.edu.cn/loginCAS")),"academic");
 assert.equal(access.ssoTarget("https://untrusted.invalid/?service="+encodeURIComponent("http://jwts.hitwh.edu.cn/loginCAS")),null);
 assert.equal(access.ssoTarget("https://ids.hit.edu.cn/authserver/reAuthCheck/reAuthLoginView.do"),null);
});

for(const protectedReadable of [false,true])test(protectedReadable?"验证码提交遇跳转中断后，受保护成绩页可读才持久化连接":"验证码提交遇跳转中断且成绩页不可读时，保留会话继续认证",async()=>{
 const browser=require('../services/browser'),pool=require('../config/database'),bindings=require('../services/schoolAccountBindings');
 const previous={release:browser.releaseContext,query:pool.query,bind:bindings.bindVerifiedOwner};
 let released=0,persisted=0;
 const owner='navigation-fixture-'+protectedReadable;
 const element={first:()=>element,fill:async()=>{},click:async()=>{throw Error('page.goto: net::ERR_ABORTED at callback')}};
 const session={openid:owner,accountKey:'fixture-hmac',step:'code',credential:{studentId:'fixture',password:'fixture'},slot:{},page:{
  evaluate:async()=>"13",locator:()=>element,waitForLoadState:async()=>{},
  request:{get:async()=>({status:()=>protectedReadable?200:302,text:async()=>'<select name="pageZydm"></select>不及格门数'})},
  context:()=>({storageState:async()=>({cookies:[],origins:[]})})
 }};
 browser.releaseContext=async()=>{released++};pool.query=async()=>{persisted++;return [{affectedRows:1}]};bindings.bindVerifiedOwner=async()=>{};
 access.sessions.set(owner,session);
 try{
  await access.code(owner,'123456');await session.job;
  assert.equal(released,0);assert.equal(session.busy,false);
  assert.equal(session.step,protectedReadable?'ready':'entry_unverified');
  assert.equal(persisted,protectedReadable?1:0);
  assert.equal(session.credential===null,protectedReadable);
 }finally{
  await access.sessions.dispose(owner);browser.releaseContext=previous.release;pool.query=previous.query;bindings.bindVerifiedOwner=previous.bind;
 }
});

test('教务CAS票据只通过VPN地址消费，不访问校内原地址',async()=>{
 const calls=[];
 const session={page:{request:{get:async(url,options)=>{
  assert.equal(new URL(url).hostname,'ids.hit.edu.cn');assert.equal(options.maxRedirects,0);
  return {status:()=>302,headers:()=>({location:'http://jwts.hitwh.edu.cn/loginCAS?ticket=fixture-once'})};
 }},goto:async url=>calls.push(url)}};
 await access.enterAcademic(session);
 assert.deepEqual(calls,[access.ORIGIN+'/loginCAS?ticket=fixture-once']);assert.equal(session.routeTarget,'academic');assert.equal(session.step,undefined);
});
test('教务要求新的二次验证时继续认证，不误报已连接',async()=>{
 const session={page:{request:{get:async()=>({status:()=>302,headers:()=>({location:'https://ids.hit.edu.cn/authserver/reAuthCheck/reAuthLoginView.do'})})},goto:async url=>{session.url=url}}};
 await access.enterAcademic(session);assert.equal(new URL(session.url).hostname,'ids.hit.edu.cn');assert.equal(session.step,undefined);
});
test('拒绝向未知站点转送教务CAS票据',async()=>{
 const session={page:{request:{get:async()=>({status:()=>302,headers:()=>({location:'https://untrusted.invalid/loginCAS?ticket=fixture'})})},goto:async()=>{throw Error('Must not navigate')}}};
 await assert.rejects(access.enterAcademic(session),e=>e.code==='ACADEMIC_CAS_REDIRECT_INVALID');
});
