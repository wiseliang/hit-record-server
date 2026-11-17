"""Generate a wholly synthetic editable sample for template/render checks."""
from pathlib import Path
import importlib.util,io,base64,hashlib,json
from PIL import Image,ImageDraw
root=Path(__file__).resolve().parents[1];spec=importlib.util.spec_from_file_location('ppt',root/'scripts/recognition-ppt.py');ppt=importlib.util.module_from_spec(spec);spec.loader.exec_module(ppt)
rows=[]
for i in range(14):
 im=Image.new('RGB',(180,240),'#DFEBF6');d=ImageDraw.Draw(im);d.rounded_rectangle((20,155,160,270),radius=55,fill='#497DAA');d.ellipse((52,45,128,127),fill='#F0CFAB');d.pieslice((47,32,133,105),180,360,fill='#35465A');d.text((65,200),'DEMO '+str(i+1),fill='white');b=io.BytesIO();im.save(b,'PNG');raw=b.getvalue()
 fields={'political':'群众（合成）','committee':'无','focus':'无','reason':'','situation':'无','other':'演示资料'}
 rows.append({'studentId':'synthetic-'+str(i),'name':'演示学生'+str(i+1).zfill(2),'className':'演示一班' if i<13 else '演示二班','fields':{k:{'value':v,'confirmed':True} for k,v in fields.items()},'photo':{'mime':'image/png','base64':base64.b64encode(raw).decode(),'sha256':hashlib.sha256(raw).hexdigest()}})
out=root/'.qa/material-demo';r=ppt.export({'rows':rows,'counselor':'演示辅导员（合成资料）','mode':'both','draft':False},root/'assets/recognition',out)
assert all(x['pages']==3 for x in r['files']);(out/'说明.txt').write_text('全部姓名、班级、个人情况和图片均为人工合成，仅作版式与功能示例，不含真实学生信息。\n',encoding='utf8');print(json.dumps(r,ensure_ascii=False))
