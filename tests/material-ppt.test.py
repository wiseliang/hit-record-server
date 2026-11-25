import unittest,importlib.util,tempfile,zipfile,base64,io,hashlib,posixpath,json
from pathlib import Path
from PIL import Image
ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('ppt',ROOT/'scripts/recognition-ppt.py');ppt=importlib.util.module_from_spec(spec);spec.loader.exec_module(ppt)
def photo(color):
 b=io.BytesIO();Image.new('RGB',(80,100),color).save(b,'PNG');raw=b.getvalue();return {'mime':'image/png','base64':base64.b64encode(raw).decode(),'sha256':hashlib.sha256(raw).hexdigest()}
def rows(n):
 return [{'studentId':'synthetic-'+str(i),'name':'合成学生'+str(i),'className':'测试甲班' if i<13 else '测试乙班','photo':photo((i*13%255,100,80)),'fields':{k:{'confirmed':True,'value':('合成政治'+str(i) if k=='political' else '合成'+k+str(i))} for k in ['political','committee','focus','reason','situation','other']}} for i in range(n)]
class PPTTests(unittest.TestCase):
 def export(self,n):
  td=tempfile.TemporaryDirectory();self.addCleanup(td.cleanup);p=Path(td.name);r=ppt.export({'rows':rows(n),'counselor':'合成辅导员','mode':'both','draft':False,'issues':[{'field':'synthetic'}]},ROOT/'assets/recognition',p);return p,r
 def test_roundtrip_and_class_pagination(self):
  for n,expected in [(1,1),(12,1),(13,2),(14,3),(25,3)]:
   with self.subTest(n=n):
    p,r=self.export(n);self.assertEqual(r['files'][0]['pages'],expected);loaded=ppt.import_ppt(p/'完整版.pptx')['rows'];self.assertEqual(len(loaded),n)
    for actual,source in zip(sorted(loaded,key=lambda x:x['name']),sorted(rows(n),key=lambda x:x['name'])):
     self.assertEqual(actual['name'],source['name']);self.assertEqual(actual['className'],source['className']);self.assertEqual(actual['fields'],{k:v['value'] for k,v in source['fields'].items()})
    self.assertEqual(len(ppt.import_ppt(p/'考核版.pptx')['rows']),0)
 def test_photos_are_independent_and_no_assessment_answers(self):
  p,r=self.export(13);z=zipfile.ZipFile(p/'考核版.pptx');blobs=b'\n'.join(z.read(n) for n in z.namelist() if n.endswith('.xml'))
  for s in rows(13):
   for value in [s['name'],s['studentId']]+[v['value'] for v in s['fields'].values()]:self.assertNotIn(value.encode(),blobs)
  self.assertFalse(any('notes' in n or 'customXml' in n for n in z.namelist()));s=ppt.xml(z.read('ppt/slides/slide1.xml'));pics=s.findall('.//p:pic',ppt.NS);self.assertEqual(len(pics),12);self.assertEqual(len({x.find('.//a:blip',ppt.NS).get('{'+ppt.NS['r']+'}embed') for x in pics}),12)
  images=[z.read(n) for n in z.namelist() if n.startswith('ppt/media/')];self.assertEqual(len(set(images)),13)
  bundle=zipfile.ZipFile(p/'辨识材料.zip');self.assertEqual(json.loads(bundle.read('校验清单.json'))['issues'],[{'field':'synthetic'}])
 def test_every_internal_relationship_resolves(self):
  p,_=self.export(14)
  for f in ['完整版.pptx','考核版.pptx']:
   z=zipfile.ZipFile(p/f);files=set(z.namelist())
   for name in files:
    if not name.endswith('.rels'):continue
    folder=posixpath.dirname(posixpath.dirname(name))
    for rel in ppt.xml(z.read(name)):
     if rel.get('TargetMode')=='External':continue
     target=rel.get('Target').split('#')[0]
     full=target.lstrip('/') if target.startswith('/') else posixpath.normpath(posixpath.join(folder,target))
     self.assertIn(full,files,(name,target))
 def test_blank_template_not_invented(self):
  self.assertEqual(ppt.import_ppt(ROOT/'assets/recognition/full.pptx')['rows'],[])
 def test_unbounded_picture_crop_is_rejected(self):
  p,_=self.export(1);file=p/'完整版.pptx';z=zipfile.ZipFile(file);deck={n:z.read(n) for n in z.namelist()};z.close();slide=ppt.xml(deck['ppt/slides/slide1.xml']);fill=slide.find('.//p:pic/p:blipFill',ppt.NS);ppt.E.SubElement(fill,'{'+ppt.NS['a']+'}srcRect',{'l':'-9999999999999'});deck['ppt/slides/slide1.xml']=ppt.data(slide)
  with zipfile.ZipFile(file,'w',zipfile.ZIP_DEFLATED) as out:
   for name,data in deck.items():out.writestr(name,data)
  with self.assertRaisesRegex(ValueError,'裁剪比例'):ppt.import_ppt(file)
 def test_export_keeps_grid_positions_and_bounds_long_text(self):
  with zipfile.ZipFile(ROOT/'assets/recognition/full.pptx') as source:
   base=ppt.slots(ppt.xml(source.read('ppt/slides/slide3.xml')))[1]
  people=rows(12)
  people[0]['fields']['reason']['value']='很长的内容'*120
  with tempfile.TemporaryDirectory() as td:
   manifest={'rows':people,'counselor':'合成辅导员','mode':'both','draft':False}
   report=ppt.export(manifest,ROOT/'assets/recognition',td)
   self.assertTrue(report['layoutBlocked'])
   self.assertFalse((Path(td)/'辨识材料.zip').exists())
   report=ppt.export({**manifest,'draft':True},ROOT/'assets/recognition',td)
   self.assertEqual(report['issues'][0]['field'],'reason')
   with zipfile.ZipFile(Path(td)/'完整版.pptx') as deck:
    cards=ppt.slots(ppt.xml(deck.read('ppt/slides/slide1.xml')))[1]
    self.assertEqual(len(cards),12)
    for actual,expected in zip(cards,base):
     self.assertEqual(list(map(ppt.box,actual)),list(map(ppt.box,expected)))
     table=actual[2]
     height=int(table.find('p:xfrm/a:ext',ppt.NS).get('cy'))
     self.assertEqual(sum(int(r.get('h')) for r in table.findall('.//a:tr',ppt.NS)),height)
   with zipfile.ZipFile(Path(td)/'考核版.pptx') as deck:
    blank_cards=ppt.slots(ppt.xml(deck.read('ppt/slides/slide1.xml')))[1]
    def grid(card):
     return [r.get('h') for r in card[2].findall('.//a:tr',ppt.NS)]
    self.assertEqual([grid(card) for card in cards],[grid(card) for card in blank_cards])
   parsed=ppt.import_ppt(Path(td)/'完整版.pptx')['rows']
   self.assertEqual(parsed[0]['fields']['reason'],'')
   self.assertEqual(parsed[4]['fields']['reason'],people[4]['fields']['reason']['value'])
 def test_unsafe_zip_and_xml(self):
  for name in ['../a','/absolute']:
   b=io.BytesIO()
   with zipfile.ZipFile(b,'w') as z:z.writestr(name,'x')
   with self.assertRaises(ValueError):ppt.safe_zip(b.getvalue())
  with self.assertRaises(ValueError):ppt.xml(b'<!DOCTYPE a [<!ENTITY a "b">]><a/>')
if __name__=='__main__':unittest.main()
