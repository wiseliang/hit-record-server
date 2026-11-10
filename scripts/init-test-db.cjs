if(!/_(stage|test)$/.test(process.env.DB_NAME||''))throw Error('Only isolated test databases may be initialized by this script')
const fs=require('fs'),path=require('path'),pool=require('../config/database')
;(async()=>{for(const sql of fs.readFileSync(path.join(__dirname,'schema.sql'),'utf8').split(';').filter(s=>s.trim()))await pool.query(sql);await require('./migrate-v12').migrate()})().finally(()=>pool.end())
