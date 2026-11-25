const {test}=require('node:test');
const assert=require('node:assert/strict');
const {encrypt}=require('../utils/crypto');
const {getImportScopes,getStudyAttributes}=require('../services/materialMemoryScope');

const job=(id,data)=>({id,updated_at:'2026-11-25T12:00:00Z',payload_encrypted:encrypt(JSON.stringify(data))});

test('an import study range contains actual writes within the current roster',()=>{
 const data=[
  job('new',{filename:'本次.pptx',importedStudentIds:['a','a','left']}),
  job('automatic',{autoApply:true,suggestedMapping:[{studentId:'b'}],report:{imported:1}}),
  job('manual',{suggestedMapping:[{studentId:'a'}],report:{imported:1}}),
 ];
 const scopes=getImportScopes(data,[{studentId:'a'},{studentId:'b'},{studentId:'outside'}]);
 assert.deepEqual(scopes.map(item=>item.studentIds),[['a'],['b'],null]);
 assert.equal(scopes[0].filename,'本次.pptx');
});

test('special attributes use confirmed values and respect the personal field switch',()=>{
 const people=[
  {studentId:'a',fields:{focus:{value:'类别一、类别二',confirmed:true},situation:{value:'正常',confirmed:true},committee:{value:'班长',confirmed:true},other:{value:'说明内容',confirmed:true},political:{value:'未确认',confirmed:false}}},
  {studentId:'b',fields:{focus:{value:'无。',confirmed:true}}},
 ];
 const ordinary=getStudyAttributes(people,false),expanded=getStudyAttributes(people,true);
 assert.deepEqual(ordinary.a,{committee:['班长']});
 assert.deepEqual(expanded.a,{focus:['类别一','类别二'],committee:['班长'],other:['有其他情况']});
 assert.equal(expanded.b,undefined);
});
