const assert = require("node:assert/strict"),
  browser = require("../services/browser"),
  driver = require("../services/recordDriver"),
  { withSemester } = require("../utils/week");
const fixture = `<!doctype html><meta charset="UTF-8"><style>.k-window{padding:10px;background:white;width:500px}#detail,#form{display:none}</style>
<table><tr><td>2022000002</td><td>同名</td><td><a href="#" onclick="openPerson('2022000002');return false">编辑/查看</a></td></tr><tr><td>2022000001</td><td>同名</td><td><a href="#" onclick="openPerson('2022000001');return false">编辑/查看</a></td></tr></table>
<div class="k-window" id="detail"><i class="k-i-close" onclick="document.getElementById('detail').style.display='none'">关闭</i><li id="th">谈话</li><div id="th"><button onclick="document.getElementById('form').style.display='block'">新增</button><div id="xq_th_grid">记录</div></div></div>
<div class="k-window" id="form"><i class="k-i-close" onclick="document.getElementById('form').style.display='none'">关闭</i><input id="xsth_thsj"><input id="xsth_thsc"><input id="xsth_thfs"><input id="xsth_thcj"><textarea id="xsth_bz"></textarea><button onclick="save()">保存</button></div>
<script>
window.rows=[];window.saves=0;window.hiddenRecords=false;window.current='';
function openPerson(id){window.current=id;document.getElementById('detail').style.display='block'}
const dropdowns={};function dd(id,values){const w={options:{dataTextField:'text'},dataSource:{data:()=>values.map(text=>({text}))},index:0,select:i=>w.index=i,trigger:()=>{},text:()=>values[w.index]};dropdowns[id]=w}
dd('xsth_thfs',['面对面','电话','网络']);dd('xsth_thcj',['其他','走访寝室']);
const grid={dataSource:{options:{serverPaging:false},read:()=>Promise.resolve(),data:()=>{const a=window.hiddenRecords?[]:window.rows.filter(r=>r.xh===window.current);a.toJSON=()=>Array.from(a);return a},total:()=>window.rows.filter(r=>r.xh===window.current).length}};
window.$=input=>{const selector=typeof input==='string'?input:'#'+input.id;return {data:type=>selector==='#xq_th_grid'?grid:selector==='#xsth_thsj'?{value:v=>document.getElementById('xsth_thsj').value=v,trigger:()=>{}}:dropdowns[selector.slice(1)]}};
function save(){window.saves++;window.rows.push({id:'receipt-'+window.saves,xh:window.current,thsj:document.getElementById('xsth_thsj').value.replaceAll('/','-').slice(0,16),bz:document.getElementById('xsth_bz').value,thsc:document.getElementById('xsth_thsc').value});document.getElementById('form').style.display='none'}
</script>`;
(async () => {
  let slot;
  try {
    const acquired = await browser.acquireContext();
    slot = acquired.slot;
    const page = acquired.page;
    await page.route("**/*", (r) =>
      r.fulfill({ contentType: "text/html", body: fixture }),
    );
    await page.goto("https://xuegong.hitwh.edu.cn/zhxy-xgzs/xg_fdygzrz/rzgl");
    await withSemester(
      { startDate: "2026-08-31", academicYear: "2026—2027", semester: "秋季" },
      async () => {
        const operation = {
          studentId: "2022000001",
          week: 1,
          type: "talk",
          payload: {
            recordedAt: "2026-08-31 09:00:00",
            content: "唯一工作内容",
            durationMinutes: 1,
            method: "网络",
            scene: "其他",
            mode: "record",
          },
        };
        const saved = await driver.saveOperation(page, operation);
        assert.equal(saved.status, "succeeded");
        assert.equal(saved.receipt.schoolRecordId, "receipt-1");
        assert.equal(await page.evaluate(() => rows[0].xh), "2022000001");
        const again = await driver.saveOperation(page, operation);
        assert.equal(again.status, "skipped");
        assert.equal(await page.evaluate(() => saves), 1);
        const missing = await driver.saveOperation(page, {
          ...operation,
          studentId: "2022000099",
        });
        assert.equal(missing.status, "not_applicable");
        assert.equal(await page.evaluate(() => saves), 1);
        const cancelled = await driver.saveOperation(
          page,
          {
            ...operation,
            payload: { ...operation.payload, content: "取消前内容" },
          },
          () => {
            const e = Error("cancel");
            e.code = "TASK_CANCELLED";
            throw e;
          },
        );
        assert.equal(cancelled.status, "cancelled");
        assert.equal(await page.evaluate(() => saves), 1);
        const invalid = await driver.saveOperation(page, {
          ...operation,
          payload: {
            ...operation.payload,
            content: "不提交",
            scene: "不存在的学校选项",
          },
        });
        assert.equal(invalid.status, "failed");
        assert.equal(await page.evaluate(() => saves), 1);
        await page.evaluate(() => {
          window.hiddenRecords = true;
        });
        const uncertain = await driver.saveOperation(page, {
          ...operation,
          payload: { ...operation.payload, content: "已保存但回查失败" },
        });
        assert.equal(uncertain.status, "unconfirmed");
        assert.equal(await page.evaluate(() => saves), 2);
        console.log(
          "RECORD_DRIVER_REAL_CHROMIUM_PASS: tiny roster, same names, stable ID, save receipt, duplicate skip, cancel boundary, invalid options, uncertain save",
        );
      },
    );
  } finally {
    if (slot) await browser.releaseContext(slot);
    await browser.shutdown();
  }
})().catch((e) => {
  console.error(e.stack);
  process.exitCode = 1;
});
