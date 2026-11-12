const {AppError}=require("../utils/errors"),{readTable,parseTable}=require("./academicParser"),{normalizeRecord}=require("./gradeAnalysis"),{ORIGIN}=require("./academicAccess");
async function html(s,path,form){
 const response=await s.page.request[form?"post":"get"](ORIGIN+path,{...(form?{form}:{}),timeout:25000,maxRedirects:0});
 if(response.status()>=300&&response.status()<400)throw new AppError(409,"ACADEMIC_AUTH_REQUIRED","教务连接过期，请重新认证");
 if(!response.ok())throw new AppError(503,"ACADEMIC_UNAVAILABLE","教务暂时无法返回查询结果");
 const body=await response.text();
 if(/id=["']password["']|id=["']dynamicCode["']/.test(body))throw new AppError(409,"ACADEMIC_AUTH_REQUIRED","教务需要重新认证");
 return body;
}
async function table(s,path,form,kind){
 const body=await html(s,path,form);
 const raw=await s.page.evaluate(({source,body})=>new Function("document","return ("+source+")()")(new DOMParser().parseFromString(body,"text/html")),{source:readTable.toString(),body});
 try{return parseTable(raw,kind)}catch(e){throw new AppError(502,"ACADEMIC_SCHEMA_CHANGED",e.message)}
}
async function options(s,query={}){
 const body=await html(s,"/xfj/queryBjxsmd");
 const basic=await s.page.evaluate(body=>{
  const d=new DOMParser().parseFromString(body,"text/html"),sel=name=>[...(d.querySelector('select[name="'+name+'"]')?.options||[])].filter(o=>o.value&&o.value!=="-1").map(o=>({value:o.value,label:o.text.trim()}));
  return {years:sel("pageNj"),faculties:sel("pageYxdm"),terms:sel("pageXnxq"),majors:[],classes:[]};
 },body);
 async function list(path,form,code,label){const r=await s.page.request.post(ORIGIN+path,{form,timeout:20000,maxRedirects:0});if(!r.ok())throw new AppError(503,"ACADEMIC_OPTIONS_FAILED","无法读取教务选项，请重连后重试");let v;try{v=await r.json()}catch{throw new AppError(502,"ACADEMIC_SCHEMA_CHANGED","教务选项结构发生变化")}if(!Array.isArray(v))throw new AppError(502,"ACADEMIC_SCHEMA_CHANGED","教务选项结构发生变化");return v.map(x=>({value:String(x[code]??""),label:String(x[label]??"")})).filter(x=>x.value&&x.label)}
 if(query.facultyCode)basic.majors=await list("/xfj/queryLdYxZy",{pageYxdm:query.facultyCode},"pageZydm","pageZymc");
 // The school lists historical major codes even when a cohort is enrolled
 // under broad experimental programmes. Offer only majors with actual students
 // for the selected year/faculty; never map unrelated programme names by guess.
 if(query.facultyCode&&query.year){
  const actual=await roster(s,{year:query.year,facultyCode:query.facultyCode,majorCode:"-1"});
  if(actual.some(x=>x.year!==query.year))throw new AppError(502,"ACADEMIC_ROSTER_MISMATCH","教务返回年级与查询条件不一致，请重新读取选项");
  const names=new Set(actual.map(x=>x.major.trim()));
  basic.majors=basic.majors.filter(x=>names.has(x.label.trim()));
 }
 if(query.majorCode&&query.year&&basic.majors.some(x=>x.value===query.majorCode))basic.classes=await list("/xfj/queryLdZyBj",{pageZydm:query.majorCode,pageNj:query.year},"pageBjdm","pageBjmc");
 return basic;
}
const formFor=scope=>({pageNj:scope.year,pageYxdm:scope.facultyCode,pageZydm:scope.majorCode,pageBjdm:"-1",pageXnxqks:"",pageXnxq:"",pagePxfs:"zrb",bs:""});
async function roster(s,scope){return table(s,"/xfj/queryBjxsmd",formFor(scope),"roster")}
async function grades(s,scope,studentId){const rows=await table(s,"/xfj/queryXscjByxh",{...formFor(scope),xh:studentId},"detail");return rows.map(normalizeRecord)}
async function course(s,scope,term,code){return table(s,"/xfj/queryCjByKc",{...formFor(scope),pageXnxq:term,pageKcdm:code},"course")}
module.exports={options,roster,grades,course};
