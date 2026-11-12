const router=require("express").Router(),service=require("../services/schoolIdentity"),{rateLimit}=require("../middleware/rateLimit");
const wrap=fn=>(req,res,next)=>Promise.resolve(fn(req,res)).catch(next);
router.post("/start",rateLimit({max:6,key:req=>"school-signin-start:"+req.ip}),wrap(async(req,res)=>res.status(202).json(await service.start(req.body))));
router.post("/status",rateLimit({max:120,key:req=>"school-signin-status:"+req.ip}),wrap(async(req,res)=>res.json(await service.status(req.body.flowId))));
for(const name of ["code","captcha","resend","create"])router.post("/"+name,rateLimit({max:12,key:req=>"school-signin-challenge:"+req.ip}),wrap(async(req,res)=>res.status(202).json(await service[name](req.body))));
router.post("/cancel",wrap(async(req,res)=>res.json(await service.cancel(req.body.flowId))));
module.exports=router;
