#!/usr/bin/env python3
"""Bounded OOXML template fill and same-layout editable PPTX import; no AI/network."""
import sys,json,zipfile,io,re,copy,hashlib,base64,os,posixpath
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from threading import Lock
from unicodedata import east_asian_width, combining
import xml.etree.ElementTree as E
NS={'p':'http://schemas.openxmlformats.org/presentationml/2006/main','a':'http://schemas.openxmlformats.org/drawingml/2006/main','r':'http://schemas.openxmlformats.org/officeDocument/2006/relationships'}
PKG='http://schemas.openxmlformats.org/package/2006/relationships';CT='http://schemas.openxmlformats.org/package/2006/content-types'
for k,v in NS.items():E.register_namespace(k,v)
FIELDS=[('committee','班委情况'),('focus','十类重点关注群体'),('reason','关注原因'),('situation','学情'),('other','其他情况')]
def xml(b):
 if len(b)>12*1024*1024 or b'<!DOCTYPE' in b.upper() or b'<!ENTITY' in b.upper():raise ValueError('不支持包含实体或超大XML的材料')
 return E.fromstring(b)
serialize_lock=Lock()
def data(x):
 # OPC package detection in office readers expects an unprefixed package root.
 with serialize_lock:
  for ns in [PKG,CT]:
   if x.tag.startswith('{'+ns+'}'):E.register_namespace('',ns)
  return E.tostring(x,encoding='utf-8',xml_declaration=True)
def text(x):return ''.join(n.text or '' for n in x.findall('.//a:t',NS))
def safe_zip(b):
 z=zipfile.ZipFile(io.BytesIO(b));items=z.infolist()
 if len(items)>5000 or sum(i.file_size for i in items)>160*1024*1024 or any(i.flag_bits&1 or i.file_size>32*1024*1024 or '..' in i.filename.split('/') or i.filename.startswith('/') for i in items):raise ValueError('PPT文件过大、加密或结构不安全')
 return z
def box(x):
 t=x.find('.//a:xfrm',NS)
 if t is None:t=x.find('p:xfrm',NS)
 if t is None:return (0,0)
 o=t.find('a:off',NS);return (int(o.get('x',0)),int(o.get('y',0))) if o is not None else (0,0)
def slots(slide):
 tree=slide.find('p:cSld/p:spTree',NS);pics=[x for x in tree if x.tag.endswith('}pic')];titles=[x for x in tree if x.tag.endswith('}sp') and '姓名' in text(x) and '辅导员' not in text(x)];tables=[x for x in tree if x.tag.endswith('}graphicFrame') and '班委' in text(x)]
 result=[];used=set()
 for pic in sorted(pics,key=lambda x:(round(box(x)[1]/200000),box(x)[0])):
  px,py=box(pic);title=min((t for t in titles if id(t) not in used),key=lambda t:abs(box(t)[0]-px)+abs(box(t)[1]-py-1100000),default=None);table=min((t for t in tables if id(t) not in used),key=lambda t:abs(box(t)[0]-px-810000)+abs(box(t)[1]-py),default=None)
  if title is not None and table is not None and abs(box(table)[1]-py)<400000 and abs(box(title)[0]-px)<800000:result.append((title,pic,table));used.update([id(title),id(table)])
 return tree,result

A='{'+NS['a']+'}'
EMU_PER_POINT=12700

def fixed_text_body(body):
 body.set('wrap','none')
 for child in list(body):
  if child.tag in (A+'noAutofit',A+'normAutofit',A+'spAutoFit'):body.remove(child)
 body.insert(0,E.Element(A+'noAutofit'))

def set_lines(paragraph,lines,size,spacing=None):
 original=paragraph.find('a:r/a:rPr',NS)
 props=copy.deepcopy(original) if original is not None else E.Element(A+'rPr')
 props.set('sz',str(size))
 for node in list(paragraph):
  if node.tag!=A+'pPr':paragraph.remove(node)
 if spacing is not None:
  ppr=paragraph.find('a:pPr',NS)
  if ppr is None:
   ppr=E.Element(A+'pPr');paragraph.insert(0,ppr)
  line_spacing=ppr.find('a:lnSpc',NS)
  if line_spacing is None:
   line_spacing=E.Element(A+'lnSpc');ppr.insert(0,line_spacing)
  line_spacing[:]=[E.Element(A+'spcPts',{'val':str(spacing)})]
 for index,line in enumerate(lines):
  if index:
   br=E.SubElement(paragraph,A+'br');br.append(copy.deepcopy(props))
  run=E.SubElement(paragraph,A+'r');run.append(copy.deepcopy(props))
  E.SubElement(run,A+'t').text=line

def fitted_lines(value,width,height,preferred,leading,single=False):
 # Leave spare width for differences between Office's Chinese font fallbacks.
 value=re.sub(r'[\r\n\t]+',' ',value)
 for size in range(preferred,749,-50):
  limit=width/(size/100)*0.93
  lines=[''];used=0
  for ch in value:
   weight=0 if combining(ch) else (1.04 if east_asian_width(ch) in 'WFA' or ord(ch)>127 else (0.94 if ch in 'MW@%' else 0.68))
   if lines[-1] and used+weight>limit:
    lines.append('');used=0
   lines[-1]+=ch;used+=weight
  spacing=round(size*leading)
  if len(lines)*spacing/100<=height and (not single or len(lines)==1):
   return lines,size,spacing
 return None

def fill_title(shape,values,max_size=1000):
 extent=shape.find('p:spPr/a:xfrm/a:ext',NS)
 body=shape.find('p:txBody/a:bodyPr',NS)
 width=(int(extent.get('cx'))-int(body.get('lIns',91440))-int(body.get('rIns',91440)))/EMU_PER_POINT
 height=(int(extent.get('cy'))-int(body.get('tIns',45720))-int(body.get('bIns',45720)))/EMU_PER_POINT
 fits=[fitted_lines(v,width,height/len(values),max_size,1.18,single=len(values)==1) for v in values]
 if not all(fits):return False
 fixed_text_body(body)
 for paragraph,fit in zip(shape.findall('p:txBody/a:p',NS),fits):
  set_lines(paragraph,*fit)
 return True

def fill_table(table,row,draft):
 # The template grid has two zero-height rows. Allocate the existing frame's
 # height across its five cells so renderers cannot grow into the card below.
 extent=table.find('p:xfrm/a:ext',NS)
 height=int(extent.get('cy'))
 table_width=int(table.find('.//a:gridCol',NS).get('w'))
 sizes=[int(height*share/100) for share in (15,24,25,15)]
 sizes.append(height-sum(sizes))
 overflow=[]
 for index,(tr,(key,label),row_height) in enumerate(zip(table.findall('.//a:tr',NS),FIELDS,sizes)):
  cell=tr.find('a:tc',NS);tx=cell.find('a:txBody',NS);tc=cell.find('a:tcPr',NS)
  value_text=value(row,key,draft)
  if key=='reason' and value(row,'focus',draft)=='无':value_text=''
  tr.set('h',str(row_height))
  width=(table_width-int(tc.get('marL',91440))-int(tc.get('marR',91440)))/EMU_PER_POINT
  text_height=(row_height-int(tc.get('marT',45720))-int(tc.get('marB',45720)))/EMU_PER_POINT-1
  leading=1.5 if index in (1,2) else 1.2
  fit=fitted_lines(label+'：'+value_text,width,text_height,1000,leading)
  if not fit:
   overflow.append(key)
   fit=fitted_lines(label+'：待补充',width,text_height,1000,leading)
  body=tx.find('a:bodyPr',NS);fixed_text_body(body)
  first,*extra=tx.findall('a:p',NS)
  for para in extra:tx.remove(para)
  set_lines(first,*fit)
 return overflow

def clean_value(v):
 s=str(v or '').strip();return '' if not s or s=='待补充' or re.fullmatch(r'[_＿xX\s.。]+',s) else s

def value(row,key,draft):
 f=row.get('fields',{}).get(key,{})
 if isinstance(f,str):return f
 return f.get('value','') if f.get('confirmed') and f.get('value') else ('待补充' if draft else '')

def normalize_export_photo(raw):
 from PIL import Image, ImageOps
 with Image.open(io.BytesIO(raw)) as photo:
  if photo.width * photo.height > 30000000:
   raise ValueError('照片像素过大')
  photo.draft('RGB', (402, 600))
  fitted = ImageOps.pad(ImageOps.exif_transpose(photo).convert('RGB'), (402, 600), color='#E3EAF2')
 out = io.BytesIO()
 fitted.save(out, format='JPEG', quality=83, optimize=True)
 return out.getvalue()


def export(manifest,templates,target):
 rows=manifest['rows'];teacher=manifest.get('counselor','');draft=manifest.get('draft',False);mode=manifest.get('mode','both');out=Path(target);out.mkdir(parents=True,exist_ok=True);report={'students':len(rows),'draft':draft,'files':[],'warnings':[],'issues':manifest.get('issues',[])};classes={}
 for row in rows:classes.setdefault(row['className'],[]).append(row)
 prepared_photos={}
 photo_keys={}
 for row in rows:
  source=row.get('photo',{}).get('base64') if row.get('photo') else None
  if not source:continue
  key=hashlib.sha256(source.encode('ascii')).digest()
  if key not in prepared_photos:
   raw=normalize_export_photo(base64.b64decode(source))
   prepared_photos[key]=(hashlib.sha256(raw).hexdigest()+'.jpeg',raw)
  photo_keys[row['studentId']]=key

 def render(variant):
  issues=[]
  warnings=[]
  template=safe_zip((Path(templates)/(variant+'.pptx')).read_bytes());slide_name='ppt/slides/slide3.xml' if variant=='full' else 'ppt/slides/slide2.xml';base=xml(template.read(slide_name));source_rels=xml(template.read(posixpath.join(posixpath.dirname(slide_name),'_rels',posixpath.basename(slide_name)+'.rels')));layout=next((r.get('Target') for r in source_rels if r.get('Type','').endswith('/slideLayout')),None)
  if not layout:raise ValueError('模板缺少布局信息')
  deck={};
  for n in template.namelist():
   if n.startswith(('ppt/slides/','ppt/notesSlides/','ppt/notesMasters/','ppt/comments/','customXml/')) or n.startswith('ppt/media/') or n in ['docProps/custom.xml','docProps/thumbnail.jpeg','docProps/thumbnail.png']:continue
   deck[n]=template.read(n)
  rootrels=xml(deck['_rels/.rels'])
  for x in list(rootrels):
   if x.get('Type','').endswith(('/custom-properties','/thumbnail')):rootrels.remove(x)
  deck['_rels/.rels']=data(rootrels)
  presentation=xml(deck['ppt/presentation.xml']);lst=presentation.find('p:sldIdLst',NS)
  for x in list(lst):lst.remove(x)
  rel=xml(deck['ppt/_rels/presentation.xml.rels'])
  for x in list(rel):
   if x.get('Type','').endswith(('/slide','/notesMaster')):rel.remove(x)
  for x in list(presentation):
   if x.tag.endswith('}notesMasterIdLst'):presentation.remove(x)
  types=xml(deck['[Content_Types].xml'])
  for x in list(types):
   if x.get('PartName','').startswith(('/ppt/slides/','/ppt/notes','/ppt/comments/','/customXml/')) or x.get('PartName')=='/docProps/custom.xml':types.remove(x)
  if not any(x.get('Extension')=='png' for x in types):E.SubElement(types,'{'+CT+'}Default',{'Extension':'png','ContentType':'image/png'})
  placeholder=normalize_export_photo(template.read('ppt/media/image1.jpeg'))
  placeholder_name=hashlib.sha256(placeholder).hexdigest()+'.jpeg'
  number=0
  for class_name,members in sorted(classes.items()):
   for offset in range(0,len(members),12):
    number+=1;s=copy.deepcopy(base);tree,cards=slots(s)
    if len(cards)!=12:raise ValueError('模板学生位置发生变化，请重新核对映射')
    relations=E.Element('{'+PKG+'}Relationships');E.SubElement(relations,'{'+PKG+'}Relationship',{'Id':'rIdLayout','Type':NS['r']+'/slideLayout','Target':layout})
    batch=members[offset:offset+12]
    for i,(title,pic,table) in enumerate(cards):
     if i>=len(batch):
      for x in (title,pic,table):tree.remove(x)
      continue
     row=batch[i]
     if variant=='full':
      if not fill_title(title,['姓名：'+row['name'],'政治面貌：'+value(row,'political',draft)]):
       issues.append({'studentId':row['studentId'],'name':row['name'],'field':'political','message':'姓名或政治面貌超出模板栏位'})
       if not fill_title(title,['姓名：'+row['name'],'政治面貌：待补充']):
        fill_title(title,['姓名：待补充','政治面貌：待补充'])
      for key in fill_table(table,row,draft):
       issues.append({'studentId':row['studentId'],'name':row['name'],'field':key,'message':'内容超出模板栏位，请精简'})
     key=photo_keys.get(row['studentId'])
     if key is None:
      warnings.append({'studentId':row['studentId'],'reason':'缺少照片，草稿保留空白占位'})
      raw=placeholder
      name=placeholder_name
     else:
      name,raw=prepared_photos[key]
     deck['ppt/media/'+name]=raw;rid='rIdPhoto'+str(i+1);E.SubElement(relations,'{'+PKG+'}Relationship',{'Id':rid,'Type':NS['r']+'/image','Target':'../media/'+name});blip=pic.find('.//a:blip',NS);blip.set('{'+NS['r']+'}embed',rid)
     meta=pic.find('p:nvPicPr/p:cNvPr',NS);meta.set('name','证件照 '+str(i+1));meta.attrib.pop('descr',None);meta.attrib.pop('title',None)
    for x in tree:
     if x.tag.endswith('}sp') and '辅导员姓名' in text(x):
      heading='辅导员姓名：'+teacher+'    班级：'+class_name+'—第'+str(offset//12+1)+'页'
      if not fill_title(x,[heading],1800):
       raise ValueError('辅导员姓名或班级过长，无法放入模板页眉')
    deck['ppt/slides/slide'+str(number)+'.xml']=data(s);deck['ppt/slides/_rels/slide'+str(number)+'.xml.rels']=data(relations);r_id='rIdGenerated'+str(number);E.SubElement(lst,'{'+NS['p']+'}sldId',{'id':str(255+number),'{'+NS['r']+'}id':r_id});E.SubElement(rel,'{'+PKG+'}Relationship',{'Id':r_id,'Type':NS['r']+'/slide','Target':'slides/slide'+str(number)+'.xml'});E.SubElement(types,'{'+CT+'}Override',{'PartName':'/ppt/slides/slide'+str(number)+'.xml','ContentType':'application/vnd.openxmlformats-officedocument.presentationml.slide+xml'})
  deck['ppt/presentation.xml']=data(presentation);deck['ppt/_rels/presentation.xml.rels']=data(rel);deck['[Content_Types].xml']=data(types)
  app=xml(deck['docProps/app.xml'])
  for x in app.iter():
   if x.tag.endswith('}Slides'):x.text=str(number)
  deck['docProps/app.xml']=data(app);filename='完整版.pptx' if variant=='full' else '考核版.pptx'
  with zipfile.ZipFile(out/filename,'w',zipfile.ZIP_DEFLATED) as z:
   for n,b in deck.items():z.writestr(n,b,compress_type=zipfile.ZIP_STORED if n.startswith('ppt/media/') else zipfile.ZIP_DEFLATED)
  return {'filename':filename,'pages':number},issues,warnings

 variants=['full','assessment'] if mode=='both' else [mode]
 if len(variants)==2:
  with ThreadPoolExecutor(max_workers=2) as executor:
   rendered=list(executor.map(render,variants))
 else:rendered=[render(variants[0])]
 report['files']=[file for file,_,_ in rendered]
 for _,issues,warnings in rendered:
  report['issues']+=issues;report['warnings']+=warnings
 if not draft and any(issues for _,issues,_ in rendered):
  for file in report['files']:(out/file['filename']).unlink()
  report['files']=[]
  report['layoutBlocked']=True
  return report
 (out/'校验清单.json').write_text(json.dumps(report,ensure_ascii=False,indent=2));archive=out/'辨识材料.zip'
 with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED) as z:
  for r in report['files']:z.write(out/r['filename'],r['filename'],compress_type=zipfile.ZIP_STORED)
  z.write(out/'校验清单.json','校验清单.json')
 return report

def read_image(z,slide,pic):
 relpath=posixpath.join(posixpath.dirname(slide),'_rels',posixpath.basename(slide)+'.rels');rels=xml(z.read(relpath));blip=pic.find('.//a:blip',NS)
 if blip is None:return None
 rid=blip.get('{'+NS['r']+'}embed');r=next((x for x in rels if x.get('Id')==rid),None)
 if r is None or r.get('TargetMode')=='External':return None
 name=posixpath.normpath(posixpath.join(posixpath.dirname(slide),r.get('Target','')))
 if not name.startswith('ppt/media/'):return None
 raw=z.read(name)
 if len(raw)>2*1024*1024:raise ValueError('单张照片超过2MiB，请先压缩')
 if not(raw.startswith(b'\xff\xd8\xff') or raw.startswith(b'\x89PNG\r\n\x1a\n')):return None
 crop=pic.find('.//a:srcRect',NS);transform=pic.find('p:spPr/a:xfrm',NS)
 if True:
  from PIL import Image,ImageOps
  im=ImageOps.exif_transpose(Image.open(io.BytesIO(raw)));w,h=im.size
  extrema=im.convert('RGB').getextrema()
  if all(hi-lo<=2 and abs((hi+lo)/2-c)<=3 for (lo,hi),c in zip(extrema,[227,234,242])):return None
  if w*h>30000000:raise ValueError('照片像素过大')
  if crop is not None:
   l,t,r,b=[int(crop.get(k,0))/100000 for k in ['l','t','r','b']]
   if any(v<0 or v>=1 for v in [l,t,r,b]) or l+r>=1 or t+b>=1:raise ValueError('照片裁剪比例无效，请先在PPT中修正')
   im=im.crop((int(w*l),int(h*t),int(w*(1-r)),int(h*(1-b))))
  if transform is not None:
   if transform.get('flipH')=='1':im=im.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
   if transform.get('flipV')=='1':im=im.transpose(Image.Transpose.FLIP_TOP_BOTTOM)
   if transform.get('rot'):im=im.rotate(-int(transform.get('rot'))/60000,expand=True)
  im.thumbnail((1000,1500));b=io.BytesIO();im.convert('RGB').save(b,format='JPEG',quality=90);raw=b.getvalue()
 return {'mime':'image/png' if raw.startswith(b'\x89PNG') else 'image/jpeg','base64':base64.b64encode(raw).decode(),'sha256':hashlib.sha256(raw).hexdigest()}

def import_ppt(filename):
 z=safe_zip(Path(filename).read_bytes());presentation=xml(z.read('ppt/presentation.xml'));rels=xml(z.read('ppt/_rels/presentation.xml.rels'));mapping={r.get('Id'):r.get('Target') for r in rels if r.get('Type','').endswith('/slide')};out=[];warnings=[]
 for page,sid in enumerate(presentation.findall('p:sldIdLst/p:sldId',NS),1):
  target=mapping.get(sid.get('{'+NS['r']+'}id'));name=posixpath.normpath(posixpath.join('ppt',target or ''))
  if not name.startswith('ppt/slides/'):raise ValueError('幻灯片关系无效')
  slide=xml(z.read(name));whole=text(slide)
  if '模板说明（提交时请删除本页）' in whole:continue
  tree,cards=slots(slide)
  if not cards:
   warnings.append('第'+str(page)+'页未识别为当前模板，未自动导入');continue
  header=next((text(x) for x in tree if x.tag.endswith('}sp') and '辅导员姓名' in text(x)),'');match=re.search(r'班级\s*[:：]\s*(.*?)(?:[-—－]?\s*第\s*\d+\s*页|$)',header);class_name=clean_value(match.group(1)) if match else ''
  for position,(title,pic,table) in enumerate(cards,1):
   ps=[''.join(n.text or '' for n in p.findall('.//a:t',NS)) for p in title.findall('.//a:p',NS)];student_name=next((re.sub(r'^姓名\s*[:：]\s*','',x) for x in ps if re.match(r'^姓名\s*[:：]',x)),'');political=next((re.sub(r'^政治面貌\s*[:：]\s*','',x) for x in ps if re.match(r'^政治面貌\s*[:：]',x)),'');fields={'political':clean_value(political)}
   for cell,(key,label) in zip(table.findall('.//a:tr/a:tc',NS),FIELDS):fields[key]=clean_value(re.sub('^'+label+r'\s*[:：]\s*','',text(cell)))
   if not clean_value(student_name) and not any(fields.values()):warnings.append('第'+str(page)+'页位置'+str(position)+'没有填写答案，无法恢复个人信息');continue
   if any(len(v)>1000 for v in fields.values()):raise ValueError('第'+str(page)+'页有字段超过1000字，请先精简')
   out.append({'index':len(out),'name':clean_value(student_name),'className':class_name,'fields':fields,'photo':read_image(z,name,pic),'sourcePage':page,'sourcePosition':position})
 return {'rows':out,'warnings':warnings,'recognized':bool(out)}

if __name__=='__main__':
 try:
  command=sys.argv[1]
  if command=='export':result=export(json.loads(Path(sys.argv[2]).read_text()),sys.argv[3],sys.argv[4])
  elif command=='import':result=import_ppt(sys.argv[2])
  else:raise ValueError('不支持的材料处理操作')
  print(json.dumps(result,ensure_ascii=False))
 except Exception as e:print(json.dumps({'error':str(e)},ensure_ascii=False));sys.exit(1)
