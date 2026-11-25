function recordsForBank(stored,decode) {
 return stored.map(record=>{
  const row=decode(record.row_encrypted);
  return {
   studentId:'ppt-row-'+row.index,
   name:row.name||'',
   className:row.className||'',
   photo:row.photo,
   fields:Object.fromEntries(Object.entries(row.fields).filter(([,value])=>value).map(([key,value])=>[key,{value,confirmed:true}])),
  };
 });
}

module.exports={recordsForBank};
