const {test} = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const vm = require('node:vm')
const crypto = require('node:crypto')
process.env.AUTH_SECRET = crypto.randomBytes(32).toString('hex')
const temp = fs.mkdtempSync(path.join(os.tmpdir(),'recorder-regression-'))
process.env.SEMESTER_CONFIG_PATH = path.join(temp,'semester.json')
const {after} = require('node:test')
after(()=>fs.rmSync(temp,{recursive:true,force:true}))
const session = require('../utils/session')
const logger = {info(){},warn(){},error(){}}
function load(relative, overrides = {}, extras = {}, suffix = '') {
  const filename = path.resolve(__dirname,'..',relative)
  const local = require('node:module').createRequire(filename)
  const context = {module:{exports:{}},require:n=>Object.hasOwn(overrides,n)?overrides[n]:local(n),process,console,Buffer,setTimeout,clearTimeout,__dirname:path.dirname(filename),...extras}
  vm.runInNewContext(fs.readFileSync(filename,'utf8')+suffix,context,{filename})
  return context.module.exports
}
test('signed sessions reject forged, expired and malformed tokens',()=>{
  const token=session.issueToken('alice')
  assert.equal(session.verifyToken(token),'alice')
  assert.equal(session.verifyToken(token+'x'),null)
  assert.equal(session.verifyToken('alice'),null)
  const payload=Buffer.from(JSON.stringify({sub:'alice',exp:1})).toString('base64url')
  const expired=payload+'.'+crypto.createHmac('sha256',process.env.AUTH_SECRET).update(payload).digest('base64url')
  assert.equal(session.verifyToken(expired),null)
})
test('HTTP routes require verified identity and task ownership',async()=>{
  const express=require('express')
  const writes=[]
  const db={query:async(sql,args)=>{
    if(sql.startsWith('SELECT task_uuid'))return [[...(args[0]==='alice-task'&&args[1]==='alice'?[{task_uuid:args[0]}]:[])]]
    writes.push([sql,args]);return [[]]
  }}
  const owner=load('middleware/owner.js',{'../config/database':db})
  const taskRoutes=load('routes/task.js',{
    '../middleware/owner':owner,
    '../config/database':db,
    '../models/task':{getTask:async()=>({status:'completed',details:[{name:'test'}]})},
    '../models/credential':{},
    '../services/orchestrator':{waitingTasks:new Map()},
    '../services/login':{pendingLogins:new Map()},
    '../utils/logger':logger,
  })
  const authRoutes=load('routes/auth.js',{
    '../models/credential':{hasCredential:async()=>false},
    '../services/login':{pendingLogins:new Map()},
    '../services/browser':{},'../services/navigator':{},'../utils/logger':logger,
  })
  const app=express();app.use(express.json())
  app.use('/api/auth',authRoutes)
  app.use('/api/task',require('../middleware/auth'),taskRoutes)
  app.use((e,req,res,next)=>res.status(500).json({error:e.message}))
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r))
  const base='http://127.0.0.1:'+server.address().port
  const request=(url,options={})=>fetch(base+url,{...options,headers:{'Content-Type':'application/json',...options.headers}})
  const authorization='Bearer '+session.issueToken('alice')
  try {
    assert.equal((await request('/api/task/alice-task')).status,401)
    assert.equal((await request('/api/task/alice-task',{headers:{'x-openid':'alice'}})).status,401)
    assert.equal((await request('/api/task/alice-task',{headers:{authorization,'x-openid':'bob'}})).status,403)
    assert.equal((await request('/api/task/bob-task',{headers:{authorization}})).status,404)
    assert.equal((await request('/api/task/bob-task/abandon',{method:'POST',headers:{authorization},body:'{}'})).status,404)
    assert.equal(writes.length,0)
    assert.equal((await request('/api/task/alice-task',{headers:{authorization}})).status,200)
    assert.equal((await request('/api/task/alice-task/abandon',{method:'POST',headers:{authorization},body:'{}'})).status,200)
    assert.equal(writes.length,1)
    const login=await request('/api/auth/login',{method:'POST',body:JSON.stringify({platform:'android',openid:'alice',code:'alice'})})
    assert.equal(login.status,200)
    const identity=await login.json()
    assert.match(identity.openid,/^android_/);assert.notEqual(identity.openid,'alice')
    assert.equal(session.verifyToken(identity.token),identity.openid)
    const again=await request('/api/auth/login',{method:'POST',headers:{authorization:'Bearer '+identity.token},body:JSON.stringify({platform:'android'})})
    assert.equal((await again.json()).openid,identity.openid)
    assert.equal((await request('/api/auth/credential')).status,401)
    const signed=session.issueToken('alice')
    const bad=await request('/api/auth/credential',{method:'POST',headers:{authorization:'Bearer '+signed},body:JSON.stringify({openid:'bob',studentId:'x',password:'x'})})
    assert.equal(bad.status,403)
  }finally{await new Promise(r=>server.close(r))}
})
test('semester updates propagate to already imported functions without timezone drift',()=>{
  const week=require('../utils/week')
  const current=week.getCurrentWeek,range=week.getWeekRange
  week.setWeekStart('2026-09-07')
  assert.equal(current(new Date('2026-11-10T00:00:00+08:00')),10)
  assert.equal(range(1),'09/07-09/13')
  week.setWeekStart('2026-11-09')
  assert.equal(current(new Date('2026-11-10T00:00:00+08:00')),1)
  assert.equal(current(new Date('2026-11-16T00:00:00+08:00')),2)
  assert.equal(range(2),'11/16-11/22')
  assert.throws(()=>week.setWeekStart('2026-02-30'))
  assert.throws(()=>week.setWeekStart('2026-11-10'))
  assert.equal(week.getWeekStart(),'2026-11-09')
})
test('semester HTTP changes require an administrator and are immediately visible',async()=>{
  const express=require('express'),config=require('../config')
  config.auth.adminOpenids=['admin']
  const router=load('routes/week.js',{'../services/calendarUpdater':{},'../utils/logger':logger})
  const app=express();app.use(express.json());app.use(router)
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r))
  const base='http://127.0.0.1:'+server.address().port
  try {
    for(const [identity,code] of [[null,401],['alice',403],['admin',200]]) {
      const headers={'Content-Type':'application/json'}
      if(identity)headers.authorization='Bearer '+session.issueToken(identity)
      const result=await fetch(base+'/set-start-date',{method:'POST',headers,body:JSON.stringify({date:'2026-09-07'})})
      assert.equal(result.status,code)
    }
    const r=await (await fetch(base+'/current')).json()
    assert.equal(r.startDate,'2026-09-07');assert.equal(r.weekRange,require('../utils/week').getWeekRange(r.week))
  }finally{await new Promise(r=>server.close(r))}
})
test('browser sessions are isolated, capacity bounded, queue resumed and duplicate release safe',async()=>{
  let created=0,live=0,maxLive=0,launches=0
  const contexts=[]
  const browser=load('services/browser.js',{
    playwright:{chromium:{launch:async()=>{launches++;return {isConnected:()=>true,newContext:async()=>{
      await new Promise(r=>setImmediate(r));created++;live++;maxLive=Math.max(maxLive,live)
      const c={id:created,cookies:[],newPage:async()=>({}),close:async()=>{live--}}
      contexts.push(c);return c
    },close:async()=>{}}}}},'../utils/logger':logger,
  })
  try {
    const slots=await Promise.all([browser.acquireContext(),browser.acquireContext(),browser.acquireContext()])
    slots[0].slot.context.cookies.push('alice')
    const next=browser.acquireContext();await new Promise(r=>setImmediate(r))
    assert.equal(browser.queueLength(),1)
    await browser.releaseContext(slots[0].slot)
    const bob=await next
    assert.notEqual(bob.slot.context,slots[0].slot.context);assert.deepEqual(bob.slot.context.cookies,[])
    assert.equal(maxLive,3);assert.equal(launches,1)
    await browser.releaseContext(slots[0].slot);assert.equal(browser.activeCount(),3)
    await Promise.all([browser.releaseContext(bob.slot),...slots.slice(1).map(s=>browser.releaseContext(s.slot))])
    assert.equal(live,0)
  }finally{await browser.shutdown()}
})
test('two-week recording aggregates progress and keeps per-week summaries',async()=>{
  const state={total:0,success_count:0,skipped_count:0,errors:null,processed:0}
  const summaries=[]
  const db={query:async(sql,args)=>{
    if(sql.startsWith('SELECT paused'))return [[{paused:0,status:'running'}]]
    if(sql.startsWith('SELECT success_count'))return [[{...state}]]
    if(sql.includes('total = COALESCE'))state.total+=args[0]
    if(sql.includes('processed=?'))Object.assign(state,{processed:args[0],success_count:args[1],skipped_count:args[2],errors:args[5]})
    if(sql==='UPDATE tasks SET errors = ? WHERE task_uuid = ?')state.errors=args[0]
    if(sql.includes('INSERT INTO weekly_summary'))summaries.push(args)
    return [[]]
  }}
  const orchestrator=load('services/orchestrator.js',{
    '../config/database':{},'../utils/logger':logger,'./browser':{},'./login':{pendingLogins:new Map()},
    './navigator':{navigateAndQuery:async()=>2,extractStudentNames:async()=>[{index:0,name:'A'},{index:1,name:'B'}]},
    './companion':{recordCompanion:async()=>({result:'success'})},'./talk':{},'../models/credential':{},
  },{},'\nmodule.exports.single = executeSingle;')
  const task={openid:'alice',type:'companion'}
  await orchestrator.single({},task,1,{},db,'task')
  await orchestrator.single({},task,3,{},db,'task')
  assert.equal(state.total,4);assert.equal(state.processed,4);assert.equal(state.success_count,4)
  assert.equal(JSON.parse(state.errors).details.length,4)
  assert.equal(summaries[0][4],2);assert.equal(summaries[1][4],2)
})
