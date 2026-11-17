"""Read-only public release verification; suitable for an independent network runner."""
from pathlib import Path
import hashlib,json,re,subprocess,tempfile,datetime
base='https://wiseliang.cloud/student-recorder/';primary='https://download.wiseliang.cloud/student-recorder/'
def get(url,headers=None):
 with tempfile.TemporaryDirectory() as temp:
  p=Path(temp)/'response';args=['curl','--fail','--silent','--show-error','--retry','2','--connect-timeout','10','--max-time','120','-o',str(p),'-w','%{http_code}']
  for key,value in (headers or {}).items():args+=['-H',key+': '+value]
  status=int(subprocess.check_output(args+[url],text=True));return status,p.read_bytes()
status,raw=get(base+'releases/');html=raw.decode();_,raw=get(base+'releases/release.json');meta=json.loads(raw);assert meta['version']=='1.16.0' and meta['versionCode']==26 and meta['status']=='ready';assert '辨识材料与记忆' in html and '正式发布：v1.16.0' in html
images=[]
for image in sorted(set(re.findall('<img[^>]+src="([^"]+)"',html))):
 status,data=get(base+'releases/'+image);assert status==200 and data;images.append({'file':image,'status':status})
for origin in [primary,base]:
 status,data=get(origin+'downloads/'+meta['file']);assert status==200 and len(data)==meta['bytes'] and hashlib.sha256(data).hexdigest()==meta['sha256'];status,data=get(origin+'downloads/'+meta['file'],{'Range':'bytes=0-1023'});assert status==206 and len(data)==1024
_,data=get(base+'api/health');school=json.loads(data);assert school['version']=='1.16.0' and school['database']=='ok';_,data=get('https://wiseliang.cloud/staff-finder/api/health');staff=json.loads(data);assert staff['version']=='3.4.0';_,data=get('https://wiseliang.cloud/palm-quiz/api/health');quiz=json.loads(data);assert quiz['version']=='0.21.0'
proof={'verifiedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'release':meta,'pageStatus':200,'images':images,'primaryAndFallbackCompleteHashVerified':True,'rangeStatus':206,'studentBackendVersion':school['version'],'staffBackendVersion':staff['version'],'quizBackendVersion':quiz['version'],'network':'independent GitHub Actions runner','browserLayoutTest':'native App flows validated separately; no desktop layout claim'}
Path('.qa/results').mkdir(parents=True,exist_ok=True);Path('.qa/results/v116_公网最终验收.json').write_text(json.dumps(proof,ensure_ascii=False,indent=2));print(json.dumps(proof,ensure_ascii=False))
