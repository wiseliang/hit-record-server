#!/usr/bin/env python3
"""Build an eight-column student workbook and photo ZIP using Python stdlib only."""
import argparse,collections,hashlib,json,os,re,zipfile
from pathlib import Path
import xml.etree.ElementTree as ET
NS='http://schemas.openxmlformats.org/spreadsheetml/2006/main'
ET.register_namespace('',NS)
def q(tag):return '{'+NS+'}'+tag
HEADERS=['姓名','学号','班级','年级','学校','专业','班号','照片文件名']
def text_row(parent,index,values,style):
    row=ET.SubElement(parent,q('row'),{'r':str(index),'ht':'22','customHeight':'1'})
    for col,value in enumerate(values):
        cell=ET.SubElement(row,q('c'),{'r':chr(65+col)+str(index),'t':'inlineStr','s':str(style)})
        ET.SubElement(ET.SubElement(cell,q('is')),q('t'),{'{http://www.w3.org/XML/1998/namespace}space':'preserve'}).text=str(value or '')
def build(manifest_path,template_path,folder):
    data=json.loads(manifest_path.read_text());folder=folder.resolve();photos=folder/'照片'
    if not data['rows']:raise ValueError('没有所带学生，不能导出空名册')
    seen=set();files=[];hashes=collections.Counter();good=[];missing=[]
    for person in data['rows']:
        sid=person['studentId']
        if not re.fullmatch(r'\d{8,16}',sid) or sid in seen:raise ValueError('学号格式无效或重复')
        seen.add(sid);images=person.get('photos',[])
        if not images:missing.append(person);continue
        if not 1<=len(images)<=3:raise ValueError('每位学生应有1至3张照片')
        if len({x['filename'] for x in images})!=len(images):raise ValueError('同一学生的照片文件名不能重复')
        for image in images:
            name=image['filename']
            if not re.fullmatch(re.escape(sid)+r'(?:_[123])?\.(?:jpg|png)',name):raise ValueError('照片文件名不符合学号规则')
            path=photos/name
            if not path.is_file() or path.is_symlink():raise ValueError('照片缺失或路径异常')
            blob=path.read_bytes();digest=hashlib.sha256(blob).hexdigest()
            if digest!=image['sha256']:raise ValueError('照片校验和不一致')
            if not (blob.startswith(b'\xff\xd8\xff') or blob.startswith(b'\x89PNG\r\n\x1a\n')):raise ValueError('照片不是支持的图像文件')
            hashes[digest]+=1;files.append(path)
        if not person.get('name'):raise ValueError('学生姓名不能为空')
        good.append(person)
    if set(p.name for p in photos.iterdir())!={p.name for p in files}:raise ValueError('照片目录包含名册以外文件')
    with zipfile.ZipFile(template_path) as z:entries={i.filename:z.read(i) for i in z.infolist()}
    sheet=ET.fromstring(entries['xl/worksheets/sheet1.xml']);shared=ET.fromstring(entries['xl/sharedStrings.xml']) if 'xl/sharedStrings.xml' in entries else None
    shared_values=[''.join(t.itertext()) for t in shared] if shared is not None else []
    sheetdata=sheet.find(q('sheetData'));header=sheetdata.find(q('row'));actual=[]
    for cell in header:
        value=cell.find(q('v'));inline=cell.find(q('is'))
        actual.append(shared_values[int(value.text)] if cell.get('t')=='s' else ''.join(inline.itertext()) if inline is not None else value.text if value is not None else '')
    if actual!=HEADERS:raise ValueError('模板表头已变化，需要更新适配')
    styles=ET.fromstring(entries['xl/styles.xml']);xfs=styles.find(q('cellXfs'));style=len(xfs)
    xf=ET.SubElement(xfs,q('xf'),{'numFmtId':'49','fontId':'0','fillId':'0','borderId':'0','xfId':'0','applyNumberFormat':'1','applyAlignment':'1'});ET.SubElement(xf,q('alignment'),{'vertical':'center'});xfs.set('count',str(len(xfs)))
    for old in list(sheetdata)[1:]:sheetdata.remove(old)
    for i,p in enumerate(good,2):text_row(sheetdata,i,[p['name'],p['studentId'],p.get('className',''),p.get('year',''),p.get('school',''),p.get('major',''),p.get('classNumber',''),';'.join(x['filename'] for x in p['photos'])],style)
    dim=sheet.find(q('dimension'))
    if dim is not None:dim.set('ref','A1:H'+str(len(good)+1))
    entries['xl/worksheets/sheet1.xml']=ET.tostring(sheet,encoding='utf-8',xml_declaration=True)
    entries['xl/styles.xml']=ET.tostring(styles,encoding='utf-8',xml_declaration=True)
    workbook=folder/'学生人员名册.xlsx'
    with zipfile.ZipFile(workbook,'w',compression=zipfile.ZIP_DEFLATED) as z:
        for name,blob in entries.items():z.writestr(name,blob)
    with zipfile.ZipFile(workbook) as z:
        assert z.testzip() is None
        reread=ET.fromstring(z.read('xl/worksheets/sheet1.xml')).find(q('sheetData'))
        assert len(reread)-1==len(good)
        for row,p in zip(list(reread)[1:],good):
            assert all(cell.get('t')=='inlineStr' and cell.get('s')==str(style) for cell in row)
            values=[''.join(cell.find(q('is')).itertext()) for cell in row]
            assert values[1]==p['studentId'];assert values[6]==p.get('classNumber','')
            assert values[7].split(';')==[x['filename'] for x in p['photos']]
    report={'ruleVersion':'student-template-v2-8-columns','headers':HEADERS,'expectedStudents':len(data['rows']),'exportedStudents':len(good),'photoCount':len(files),'missingStudents':len(missing),'duplicateStudentIds':0,'orphanPhotos':0,'duplicateImagePeople':sum(n for n in hashes.values() if n>1),'textColumns':['学号','班号'],'exportedAt':data['exportedAt'],'missing':[{'studentId':p['studentId'],'name':p['name'],'reason':p.get('reason','尚无有效照片')} for p in missing]}
    (folder/'校验清单.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    (folder/'导出说明.txt').write_text('按新版学生模板八列导出。学号、班号及其他单元格均以文本保存。\n照片目录：照片/；照片文件名按学号命名；多张用分号分隔。\n当前教务来源每名学生提供一张照片，不复制同一照片凑数。\n专业与班号为选填；班号仅取学校已有班号或明确的班级代码，不猜测补全。\n总人数：'+str(len(data['rows']))+'；已导出：'+str(len(good))+'；缺少照片：'+str(len(missing))+'。\n缺少照片的学生不写入首张人员名册，详见校验清单；任务会标为部分完成。\n')
    package_files=[workbook,folder/'导出说明.txt',folder/'校验清单.json',*files]
    with zipfile.ZipFile(folder/'照片与名册.zip','w',compression=zipfile.ZIP_DEFLATED,compresslevel=6) as z:
        for file in package_files:z.write(file,str(Path('所带学生照片与名册')/file.relative_to(folder)))
    with zipfile.ZipFile(folder/'照片与名册.zip') as z:assert z.testzip() is None;assert len(z.namelist())==len(files)+3
    for path in package_files+[folder/'照片与名册.zip']:path.chmod(0o600)
    print(json.dumps({k:v for k,v in report.items() if k!='missing'},ensure_ascii=False))
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--manifest',required=True);p.add_argument('--template',required=True);p.add_argument('--folder',required=True);a=p.parse_args();build(Path(a.manifest),Path(a.template),Path(a.folder))
