// Publish an already verified APK and its checksum metadata to this project's release page.
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const [apkPath,metadataPath]=process.argv.slice(2);
if(!apkPath||!metadataPath)throw Error('用法：node scripts/publish-release.cjs 安装包.apk 安装包校验.json');
const metadata=JSON.parse(fs.readFileSync(metadataPath,'utf8')),data=fs.readFileSync(apkPath),sha256=crypto.createHash('sha256').update(data).digest('hex');
if(sha256!==metadata.sha256||!/^\d+\.\d+\.\d+$/.test(metadata.version)||!Number.isInteger(metadata.versionCode)||metadata.package!=='com.wiseliang.studentrecorder')throw Error('安装包校验信息不匹配，未发布');
const publicDir=path.resolve(__dirname,'../public/releases'),dir=process.env.RELEASE_DOWNLOAD_DIR||path.resolve(__dirname,'../.data/public-downloads'),file='student-recorder-v'+metadata.version+'.apk',manifestPath=path.join(publicDir,'release.json');
const old=JSON.parse(fs.readFileSync(manifestPath,'utf8'));if(old.versionCode&&metadata.versionCode<old.versionCode)throw Error('不能用低版本覆盖当前发布');if(old.versionCode===metadata.versionCode&&old.sha256&&old.sha256!==sha256)throw Error('同一版本不能替换不同安装包，请先升级版本号');
fs.mkdirSync(dir,{recursive:true});const temp=path.join(dir,file+'.tmp');fs.writeFileSync(temp,data);fs.renameSync(temp,path.join(dir,file));
const release={version:metadata.version,versionCode:metadata.versionCode,status:'ready',file,bytes:data.length,sha256,minimumAndroid:metadata.minimumAndroid||'7.0',architecture:'arm64-v8a',updatedAt:new Date().toISOString()};
fs.writeFileSync(manifestPath+'.tmp',JSON.stringify(release,null,2)+'\n');fs.renameSync(manifestPath+'.tmp',manifestPath);console.log('已更新发布页面：v'+metadata.version+'，'+data.length+' 字节');
