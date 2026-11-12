// Runs in an authenticated school page. Returns data only; never includes raw HTML.
function readTable() {
  const norm=s=>String(s??"").replace(/\s+/g,"").trim();
  const tables=[...document.querySelectorAll("table.bot_line")];
  const table=tables.find(t=>[...t.rows].some(r=>r.textContent.includes("序号")));
  if(!table) return {headers:[],rows:[],missing:true,pagination:false};
  const rows=[...table.rows];
  const headIndex=rows.findIndex(r=>r.textContent.includes("序号"));
  const headers=[...rows[headIndex].cells].map(c=>norm(c.textContent));
  const data=rows.slice(headIndex+1).filter(r=>r.cells.length===headers.length&&/^\d+$/.test(norm(r.cells[0].textContent))).map(r=>[...r.cells].map(c=>c.textContent.trim()));
  const pagination=[...document.querySelectorAll("a,[onclick],input")].some(e=>/下一页|末页/.test(e.textContent||e.value||"")&&!e.disabled);
  return {headers,rows:data,pagination};
}
function parseTable(table,kind) {
  const specs={
    roster:{studentId:"学号",name:"姓名",className:"班级",year:"年级",faculty:"院系",major:"专业",weightedScore:"学分绩",schoolFailedCount:"不及格门数",classRank:"班级排名"},
    detail:{sourceIndex:"序号",semester:"学年学期",faculty:"开课院系",code:"课程代码",name:"课程名称",nature:"课程性质",category:"课程类别",credits:"学分",exam:"是否考试课",weighted:"参与学分绩",attempt:"补考重修标记",score:"总成绩",remark:"成绩备注",rank:"教学班排名"},
    course:{code:"课程代码",courseName:"课程名称",studentId:"学号",name:"姓名",className:"班级",score:"成绩",classRank:"单科班级排名",majorRank:"单科专业排名"},
  };
  const spec=specs[kind];if(!spec)throw Error("未知成绩表类型");
  for(const h of Object.values(spec))if(!table.headers?.includes(h))throw Error("教务成绩表结构已变化，请更新适配后重试");
  if(table.pagination)throw Error("教务返回分页，尚不能确认结果完整，请缩小查询范围");
  const result=table.rows.map(row=>Object.fromEntries(Object.entries(spec).map(([k,h])=>[k,row[table.headers.indexOf(h)]?.trim()??""])));
  if (kind!=="detail") {
    if(result.some(r=>!r.studentId||!/^[A-Za-z0-9_-]{4,32}$/.test(r.studentId)))throw Error("教务学号字段异常");
    if(kind==="roster" && new Set(result.map(r=>r.studentId)).size!==result.length)throw Error("教务名单存在重复学号，请核实");
  } else {
    if(result.some((r,i)=>Number(r.sourceIndex)!==i+1))throw Error("课程序号不连续，无法确认读取完整");
  }
  return result;
}
module.exports={readTable,parseTable};
