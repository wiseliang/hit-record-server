const {test}=require('node:test'),assert=require('node:assert/strict'),reader=require('../services/academicSchoolReader');
test('按实际年级名单过滤历史专业选项，避免选择不存在的培养专业后得到零人',async()=>{
 const headers=['序号','学号','姓名','班级','年级','院系','专业','学分绩','不及格门数','班级排名'];
 const majors=[{pageZydm:'old',pageZymc:'测控技术与仪器'},{pageZydm:'broad',pageZymc:'工科试验班'}];
 let rosterForm;
 const s={page:{request:{get:async()=>({ok:()=>true,status:()=>200,text:async()=>'<fixture>'}),post:async(path,options)=>{
  if(path.endsWith('/queryLdYxZy'))return {ok:()=>true,json:async()=>majors};
  if(path.endsWith('/queryBjxsmd')){rosterForm=options.form;return {ok:()=>true,status:()=>200,text:async()=>'<fixture>'}}
  throw Error('Unexpected request');
 }},evaluate:async(_fn,arg)=>typeof arg==='object'?{headers,rows:[['1','20250001','测试','A','2025','学院','工科试验班','80','0','1']],pagination:false}:{years:[],faculties:[],terms:[],majors:[],classes:[]}}};
 const result=await reader.options(s,{year:'2025',facultyCode:'F'});
 assert.deepEqual(result.majors,[{value:'broad',label:'工科试验班'}]);assert.equal(rosterForm.pageZydm,'-1');assert.equal(rosterForm.pageNj,'2025');
});
