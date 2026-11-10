const express=require('express'),fs=require('fs'),path=require('path'),{AppError}=require('../utils/errors');
const router=express.Router(),publicDir=path.resolve(__dirname,'../public/releases');
const manifest=()=>JSON.parse(fs.readFileSync(path.join(publicDir,'release.json'),'utf8'));
router.get('/downloads/:filename',(req,res,next)=>{try{const release=manifest(),name=req.params.filename==='latest.apk'?release.file:req.params.filename;if(!/^student-recorder-v\d+\.\d+\.\d+\.apk$/.test(name))throw new AppError(404,'DOWNLOAD_NOT_FOUND','没有这个版本的安装包');const dir=process.env.RELEASE_DOWNLOAD_DIR||path.resolve(__dirname,'../.data/public-downloads'),file=path.join(dir,name);if(!fs.existsSync(file))throw new AppError(503,'DOWNLOAD_UNAVAILABLE','安装包暂时不可用，请稍后刷新下载页面');res.type('application/vnd.android.package-archive');res.download(file,'学工录入助手_'+name.replace('student-recorder-',''),error=>{if(error&&!res.headersSent)next(error)})}catch(e){next(e)}});
router.get('/releases',(req,res,next)=>{if(!req.path.endsWith('/'))return res.redirect(308,'releases/');next()});
router.use('/releases',express.static(publicDir,{index:'index.html',dotfiles:'deny'}));
module.exports=router;
