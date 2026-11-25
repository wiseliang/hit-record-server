const {test}=require('node:test'),assert=require('node:assert/strict');
const {recordsForBank}=require('../services/materialStudyBank'),{makeCards}=require('../services/materials');
test('同名同班的 PPT 记录分别生成整人照片题并保留原有资料',()=>{
 const rows=[0,1].map(index=>({row_encrypted:JSON.stringify({
  index,name:'合成学生',className:'合成班',photo:{sha256:String(index),mime:'image/jpeg',base64:'photo'+index},
  fields:{political:'群众',committee:'无',focus:'合成类型',reason:'合成原因',situation:'合成学情',other:'合成记录'+index},
 })}));
 const {cards,images}=makeCards(recordsForBank(rows,JSON.parse),true,true);
 const profiles=cards.filter(c=>c.kind==='profile');
 assert.equal(profiles.length,2);
 assert.notEqual(profiles[0].sourceId,profiles[1].sourceId);
 assert.deepEqual(profiles.map(card=>card.imageId),['0','1']);
 assert.deepEqual(Object.keys(images),['0','1']);
 assert(profiles.every(card=>card.answer.length===8));
 assert.match(profiles[1].answer.join(' '),/姓名：合成学生.*班级：合成班.*其他情况：合成记录1/);
});
