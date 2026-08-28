'use client';
import { useState, useEffect, useCallback, useRef } from 'react';


// ── Injected Styles ────────────────────────────────────────────────
if (typeof document !== 'undefined' && !document.getElementById('sb-custom-styles')) {
  const style = document.createElement('style');
  style.id = 'sb-custom-styles';
  style.textContent = `
    @keyframes flashGreen { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }
    @keyframes flashRed { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }
    @keyframes progressPulse { 0%,100% { opacity: 0.8; } 50% { opacity: 1; } }

    /* ── Tape design system (Direction A handoff) ─────────────────── */
    .tp{--bg:#0A0B0D;--panel:#101216;--panel2:#15181C;--panel3:#0C0E11;--line:#1F242A;--line-soft:#14171B;--line2:#2A3138;--text:#E7E9EC;--dim:#79818B;--dim2:#7C848F;--take:#4C9AFF;--fade:#FF8A3D;--win:#34C77B;--loss:#E5484D;--body:'IBM Plex Sans',-apple-system,BlinkMacSystemFont,sans-serif;--mono:'IBM Plex Mono','SF Mono',monospace;font-family:var(--body);color:var(--text);background:var(--bg)}
    .tp *{box-sizing:border-box}
    .tp button{font-family:inherit;-webkit-appearance:none;appearance:none;cursor:pointer}
    .tp .num{font-variant-numeric:tabular-nums}
    .ah{padding:10px 14px 10px;display:flex;align-items:baseline;justify-content:space-between;position:sticky;top:0;background:var(--bg);z-index:5}
    .ah b{font:600 13px/1 var(--body);letter-spacing:.14em;text-transform:uppercase;color:var(--text)}
    .ah span{font:500 10px/1 var(--mono);letter-spacing:.06em;color:var(--dim2)}
    .ah span.warn{color:var(--fade)}
    .ah span.clickable{color:var(--take);cursor:pointer}
    .astrip{display:grid;grid-template-columns:repeat(3,1fr);border-top:1px solid var(--line);border-bottom:1px solid var(--line);background:var(--panel)}
    .astrip.g2{grid-template-columns:repeat(2,1fr)}
    .astrip>div{padding:10px 14px;border-right:1px solid var(--line);display:flex;flex-direction:column;gap:4px}
    .astrip>div:last-child{border-right:0}
    .astrip .k{font:500 9px/1 var(--mono);letter-spacing:.13em;text-transform:uppercase;color:var(--dim2)}
    .astrip .k em{font-style:normal;font-size:9px;color:#565e68;margin-left:4px;text-transform:none;letter-spacing:0}
    .astrip .v{font:600 19px/1 var(--mono);letter-spacing:-.02em;color:var(--text)}
    .astrip .v s{text-decoration:none;font-size:11px;color:var(--dim);margin-left:1px}
    .astrip .v.hot{color:var(--take)}
    .astrip .v.up{color:var(--win)}
    .astrip .v.dn{color:var(--loss)}
    .datepick{display:flex;gap:6px;padding:7px 14px;background:var(--panel3);border-bottom:1px solid var(--line)}
    .datepick button{font:500 9px/1 var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--dim2);background:none;border:1px solid var(--line2);border-radius:3px;padding:4px 9px}
    .datepick button.on{color:var(--take);border-color:rgba(76,154,255,.5);background:rgba(76,154,255,.12)}
    .sizerow{display:flex;align-items:center;background:var(--panel3);border-bottom:1px solid var(--line)}
    .sizerow .sl{flex:0 0 auto;padding:0 11px 0 14px;font:500 9px/1 var(--mono);letter-spacing:.11em;text-transform:uppercase;color:var(--dim2)}
    .sizerow .seg{display:flex;flex:1;border-left:1px solid var(--line)}
    .sizerow .seg button{flex:1;background:none;border:0;border-right:1px solid var(--line);padding:10px 0;font:500 9.5px/1 var(--mono);letter-spacing:.07em;text-transform:uppercase;color:var(--dim2);font-variant-numeric:tabular-nums}
    .sizerow .seg button:last-child{border-right:0}
    .sizerow .seg button.on{background:var(--panel);color:var(--take);box-shadow:inset 0 1px 0 var(--take)}
    .rangerow{display:flex;background:var(--panel3);border-bottom:1px solid var(--line)}
    .rangerow button{flex:1;background:none;border:0;border-right:1px solid var(--line);padding:9px 0;font:500 9px/1 var(--mono);letter-spacing:.09em;text-transform:uppercase;color:var(--dim2)}
    .rangerow button:last-child{border-right:0}
    .rangerow button.on{background:var(--panel);color:var(--take)}
    .arule{background:var(--panel2);border-bottom:1px solid var(--line);padding:11px 14px 12px;display:flex;flex-direction:column;gap:9px}
    .arule-top{display:flex;align-items:center;justify-content:space-between}
    .arule-top .lb{font:500 9px/1 var(--mono);letter-spacing:.13em;text-transform:uppercase;color:var(--dim2)}
    .arule-top .rs{font:500 11px/1 var(--mono);color:var(--dim)}
    .arule-top .rs b{color:var(--take);font-weight:600}
    .ruler{position:relative;height:30px;display:grid;grid-template-columns:repeat(3,1fr);gap:2px;touch-action:none}
    .ruler .seg{border:1px solid var(--line2);border-radius:3px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;background:#0d0f12;cursor:pointer}
    .ruler .seg em{font:600 12px/1 var(--mono);font-style:normal;color:var(--dim)}
    .ruler .seg i{font:500 8px/1 var(--mono);letter-spacing:.08em;color:var(--dim2);font-style:normal}
    .ruler .seg.on{background:rgba(76,154,255,.13);border-color:rgba(76,154,255,.5)}
    .ruler .seg.on em{color:#a9cfff}
    .ruler .seg.on i{color:rgba(169,207,255,.6)}
    .ruler .handle{position:absolute;top:-4px;bottom:-4px;width:2px;background:var(--take);box-shadow:0 0 8px rgba(76,154,255,.7);cursor:grab;pointer-events:none}
    .ruler .handle::after{content:"";position:absolute;top:50%;left:-4px;width:10px;height:10px;margin-top:-5px;border-radius:2px;background:var(--take)}
    .arule-act{display:grid;grid-template-columns:1fr auto;gap:8px}
    .abtn{height:38px;border-radius:4px;border:1px solid rgba(76,154,255,.45);background:rgba(76,154,255,.14);color:#bcd9ff;font:600 12px/1 var(--body);letter-spacing:.09em;text-transform:uppercase;display:flex;align-items:center;justify-content:center;gap:8px}
    .abtn.solid{background:var(--take);border-color:var(--take);color:#03142c}
    .abtn.ghost{border-color:var(--line2);background:transparent;color:var(--dim);padding:0 14px}
    .abtn.on{border-color:var(--take);color:var(--take);background:rgba(76,154,255,.1)}
    .abtn:disabled{opacity:.4;cursor:default}
    .undobar{display:flex;align-items:center;justify-content:space-between;padding:8px 14px;background:var(--panel3);border-bottom:1px solid var(--line)}
    .undobar .ul{font:500 10px/1 var(--mono);letter-spacing:.06em;text-transform:uppercase;color:var(--dim)}
    .undobar .ct{font:400 10px/1 var(--mono);color:var(--dim2);margin-left:8px}
    .undobar .ub{font:500 10px/1 var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--take);background:rgba(76,154,255,.12);border:1px solid rgba(76,154,255,.5);border-radius:3px;padding:5px 11px}
    .aleagues{display:flex;border-bottom:1px solid var(--line);background:var(--bg)}
    .aleagues button{flex:1;background:none;border:0;border-right:1px solid var(--line);padding:9px 0 8px;display:flex;flex-direction:column;align-items:center;gap:3px}
    .aleagues button:last-child{border-right:0;flex:0 0 42px}
    .aleagues .lg{font:600 10px/1 var(--body);letter-spacing:.1em;color:var(--dim2)}
    .aleagues .ct{font:500 10px/1 var(--mono);color:var(--dim2)}
    .aleagues .sel{background:var(--panel)}
    .aleagues .sel .lg{color:var(--text)}
    .aleagues .sel .ct{color:var(--take)}
    .aleagues .glyph{font:500 13px/1 var(--mono);color:var(--dim2)}
    .aleagues button:disabled{opacity:.35}
    .aleagues.scroll{overflow-x:auto;-webkit-overflow-scrolling:touch;scrollbar-width:none}
    .aleagues.scroll::-webkit-scrollbar{display:none}
    .aleagues.scroll button{flex:0 0 auto;min-width:62px;padding:9px 12px 8px}
    .aleagues.scroll button:last-child{position:sticky;right:0;flex:0 0 42px;min-width:42px;background:var(--bg);border-left:1px solid var(--line);border-right:0;justify-content:center}
    .agame{border-bottom:1px solid var(--line)}
    .agh{display:flex;align-items:center;gap:8px;padding:8px 14px 7px;background:#0c0e11}
    .agh .lgm{font:600 9px/1 var(--mono);letter-spacing:.1em;color:var(--dim2);width:26px;flex-shrink:0}
    .agh .tm2{font:600 11px/1 var(--body);color:var(--text);letter-spacing:.01em}
    .agh .at{font:400 11px/1 var(--body);color:var(--dim2)}
    .agh .tme{margin-left:auto;font:500 10px/1 var(--mono);color:var(--dim2);letter-spacing:.03em}
    .agh .live{margin-left:auto;display:flex;align-items:center;gap:6px;font:500 10px/1 var(--mono);color:var(--win)}
    .agh .live b{width:5px;height:5px;border-radius:50%;background:var(--win);display:block}
    .agh .close{margin-left:auto;font:500 10px/1 var(--mono);letter-spacing:.03em;color:var(--take)}
    .agh .sc{font:600 12px/1 var(--mono);color:var(--text);margin-left:2px}
    .r{display:grid;grid-template-columns:3px 1fr 54px 46px 72px;align-items:center;gap:9px;height:56px;padding-right:12px;border-top:1px solid #14171b;background:var(--bg)}
    .r.first{border-top:0}
    .tick{height:0;width:3px;background:var(--dim2);align-self:end;margin-bottom:9px}
    .t10{height:26px}.t7{height:17px}.t5{height:9px}
    .rm{display:flex;align-items:center;gap:8px;min-width:0;padding-left:6px}
    .mkt{font:500 9px/1 var(--mono);letter-spacing:.1em;color:var(--dim2);width:24px;flex:0 0 24px}
    .tm{flex:0 0 22px;width:22px;height:22px;border-radius:5px;background:#171a1e;display:flex;align-items:center;justify-content:center;overflow:hidden;box-shadow:inset 0 0 0 1px rgba(255,255,255,.1)}
    .tm img{width:100%;height:100%;object-fit:contain}
    .tm.ou{font:700 9px/1 var(--body);color:var(--dim)}
    .side{font:500 13px/1.1 var(--body);color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .side i{font-style:normal;color:var(--dim);font-weight:400}
    .u{font:600 17px/1 var(--mono);letter-spacing:-.02em;color:var(--text);text-align:right}
    .u em{font-style:normal;font-size:9px;color:var(--dim2);margin-left:1px}
    .u.conv{color:var(--dim2)}
    .p{font:400 11px/1 var(--mono);color:var(--dim);text-align:right}
    .tri{display:grid;grid-template-columns:repeat(3,1fr);height:44px;border:1px solid var(--line2);border-radius:4px;overflow:hidden}
    .tri s{text-decoration:none;display:flex;align-items:center;justify-content:center;font:600 9px/1 var(--mono);color:var(--dim2);border-right:1px solid var(--line2);background:#0d0f12;cursor:pointer;-webkit-tap-highlight-color:transparent}
    .tri s:last-child{border-right:0}
    .tri s.on{background:var(--take);color:#03142c}
    .tri s.onf{background:var(--fade);color:#2b1200}
    /* 3-way soccer moneyline: four outcome segments (– H D A) instead of three
       action segments. The row borrows 20px from the name column so each segment
       keeps roughly the width the 3-segment control has, rather than shrinking to
       an untappable sliver. */
    .tri.quad{grid-template-columns:repeat(4,1fr)}
    .r.q3{grid-template-columns:3px 1fr 52px 44px 88px}
    /* Marker dot = the side the model itself took. Tapping it is a Take; tapping
       any other segment is a Fade to that side. */
    .tri s.mdl{position:relative}
    .tri s.mdl::after{content:'';position:absolute;top:5px;left:50%;margin-left:-1.5px;width:3px;height:3px;border-radius:2px;background:var(--dim2)}
    .tri s.mdl.on::after,.tri s.mdl.onf::after{background:rgba(0,0,0,.5)}
    /* No price for this side (pre-migration row, or a match never quoted 3-way). */
    .tri s.off{color:#333940;background:#0a0c0e;cursor:default}
    .r.take{background:rgba(76,154,255,.05)}
    .r.take .tick{background:var(--take)}
    .r.take .u{color:#cfe4ff}
    .r.fade{background:rgba(255,138,61,.05)}
    .r.fade .tick{background:var(--fade)}
    .r.fade .u{color:#ffd6b3}
    .r.fade .side i{color:var(--fade)}
    .more{padding:7px 14px 8px 32px;font:500 10px/1 var(--mono);letter-spacing:.06em;color:var(--dim2);border-top:1px solid #14171b;background:#0c0e11;cursor:pointer}
    .apnl{font:600 15px/1 var(--mono);text-align:right;letter-spacing:-.02em}
    .apnl.up{color:var(--win)}.apnl.dn{color:var(--loss)}.apnl.fl{color:var(--dim)}
    .apnl em{font-style:normal;font-size:9px;color:#565e68;margin-left:1px}
    .clockbar{grid-column:5;height:4px;border-radius:2px;background:#191d22;position:relative;overflow:hidden}
    .clockbar b{position:absolute;inset:0 auto 0 0;background:var(--line2);transition:width .6s ease}
    .r.locked .tri{display:none}
    .tapebar{display:flex;height:6px;border-bottom:1px solid var(--line)}
    .tapebar i{display:block;height:100%}
    .agrid{display:grid;grid-template-columns:1fr 1fr;border-bottom:1px solid var(--line)}
    .agrid>div{padding:13px 14px;border-right:1px solid var(--line);border-top:1px solid var(--line);display:flex;flex-direction:column;gap:5px}
    .agrid>div:nth-child(2n){border-right:0}
    .agrid>div:nth-child(-n+2){border-top:0}
    .agrid .k{font:500 9px/1 var(--mono);letter-spacing:.13em;text-transform:uppercase;color:var(--dim2)}
    .agrid .v{font:600 24px/1 var(--mono);letter-spacing:-.03em;color:var(--text)}
    .agrid .v.up{color:var(--win)}
    .agrid .v.dn{color:var(--loss)}
    .agrid .v s{text-decoration:none;font-size:12px;color:#565e68;margin-left:4px}
    .agrid .v.same{color:#4A5058}
    .agrid .d{display:block;font:500 9px/1 var(--mono);color:var(--dim2);margin-top:2px}
    .priced{display:flex;align-items:center;justify-content:space-between;padding:9px 14px;background:rgba(76,154,255,.07);border-bottom:1px solid var(--line)}
    .priced .pl{font:500 9px/1 var(--mono);letter-spacing:.1em;text-transform:uppercase;color:#9FD0FF}
    .priced .pr{display:flex;border:1px solid var(--line2);border-radius:3px;overflow:hidden}
    .priced .pr button{background:none;border:0;padding:6px 11px;font:500 9px/1 var(--mono);letter-spacing:.07em;text-transform:uppercase;color:var(--dim2)}
    .priced .pr button.on{background:rgba(76,154,255,.16);color:#9FD0FF}
    .chart{height:120px;padding:14px 14px 10px;border-bottom:1px solid var(--line);position:relative;overflow:hidden}
    .chart .cap{position:absolute;top:12px;right:14px;font:500 9px/1 var(--mono);letter-spacing:.1em;color:var(--dim2)}
    .dayh{padding:9px 14px 7px;background:#0c0e11;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;align-items:center}
    .dayh .d{font:600 10px/1 var(--mono);letter-spacing:.1em;text-transform:uppercase;color:var(--dim)}
    .dayh .t{font:600 11px/1 var(--mono)}
    .lr{display:grid;grid-template-columns:14px 16px 1fr auto auto;gap:9px;align-items:center;padding:9px 14px;border-bottom:1px solid #14171b}
    .lr .res{font:700 11px/1 var(--mono)}
    .lr .res.w{color:var(--win)}.lr .res.l{color:var(--loss)}.lr .res.p{color:var(--dim2)}
    .lr .nm{font:500 12px/1.2 var(--body);color:#cfd4da;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .lr .nm span{color:var(--dim2);font-size:11px}
    .lr .pr{font:400 10px/1 var(--mono);color:var(--dim2)}
    .lr .un{font:600 12px/1 var(--mono);width:52px;text-align:right}
    .lr .un.w{color:var(--win)}.lr .un.l{color:var(--loss)}.lr .un.p{color:var(--dim2)}
    .tabs{display:grid;border-top:1px solid var(--line);background:var(--panel);padding:9px 0 calc(10px + env(safe-area-inset-bottom, 8px))}
    .tabs button{background:none;border:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:5px;position:relative}
    .tabs .ti{width:20px;height:20px;object-fit:contain;opacity:.4;filter:grayscale(1);transition:opacity .15s,filter .15s}
    .tabs .tl{font:500 9px/1 var(--mono);letter-spacing:.09em;text-transform:uppercase;color:var(--dim2)}
    .tabs .on .ti{opacity:1;filter:none}
    .tabs .on .tl{color:var(--take)}
    .tabs .badge{position:absolute;top:-2px;right:14px;background:var(--fade);color:#2b1200;font:700 8px/1 var(--mono);width:13px;height:13px;border-radius:7px;display:flex;align-items:center;justify-content:center}
    .sr{display:grid;grid-template-columns:3px 1fr 46px 42px 50px;gap:9px;align-items:center;height:44px;padding-right:12px;border-top:1px solid #14171b}
    .sr.first{border-top:0}
    .sr .rm{padding-left:6px}
    .sr.take{background:rgba(76,154,255,.05)}
    .sr.take .tick{background:var(--take)}
    .sr.fade{background:rgba(255,138,61,.05)}
    .sr.fade .tick{background:var(--fade)}
    .sr .un{font:500 12px/1 var(--mono);color:var(--dim);text-align:right}
    .ls{padding:11px 13px 12px;border-top:1px solid #14171b;background:#0c0e11;display:grid;grid-template-columns:1fr repeat(6,25px);gap:7px 0;align-items:center;overflow-x:auto}
    .ls .hd{font:500 9px/1 var(--mono);color:var(--dim2);text-align:center}
    .ls .tn{font:500 11px/1 var(--body);color:var(--dim)}
    .ls .n{font:500 11px/1 var(--mono);text-align:center;color:#c4cad1}
    .ls .n.t{color:var(--text);font-weight:600}
    .adet{padding:10px 13px 11px;border-top:1px solid #14171b;display:flex;flex-direction:column;gap:5px}
    .adet .p1{font:500 12px/1 var(--body);color:var(--text)}
    .adet .p2{font:400 10px/1 var(--mono);color:var(--dim2)}
    .astat{display:grid;grid-template-columns:28px 1fr auto;gap:9px;align-items:baseline;padding:4px 13px}
    .astat .k{font:500 9px/1 var(--mono);letter-spacing:.11em;color:var(--dim2)}
    .astat .n{font:500 11px/1 var(--body);color:#c4cad1}
    .astat .n s{text-decoration:none;color:var(--dim2);font-size:10px}
    .astat .v{font:400 10px/1 var(--mono);color:var(--dim)}
    .ameta{padding:9px 13px 10px;margin-top:5px;border-top:1px solid #14171b;background:#0c0e11;display:flex;gap:11px;flex-wrap:wrap;font:400 9px/1.3 var(--mono);color:var(--dim2)}
    .acon{display:grid;grid-template-columns:26px auto 1fr auto auto 50px;gap:8px;align-items:center;height:44px;padding:0 12px 0 13px;border-top:1px solid #14171b;cursor:pointer}
    .acon .lg{font:600 9px/1 var(--mono);color:var(--dim2)}
    .acon .mt{font:500 12px/1 var(--body);color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .acon .mt s{text-decoration:none;color:var(--dim2);font-weight:400}
    .acon .sc{font:600 12px/1 var(--mono);color:var(--text);letter-spacing:.02em}
    .acon .pos{font:500 11px/1 var(--mono);text-align:right}
    .acon.live .lg{color:var(--win)}
    .tmini{flex:0 0 16px;width:16px;height:16px;border-radius:4px;background:#171a1e;display:flex;align-items:center;justify-content:center;overflow:hidden;box-shadow:inset 0 0 0 1px rgba(255,255,255,.12)}
    .tmini img{width:100%;height:100%;object-fit:contain}
    .duo{display:flex;gap:3px;flex:0 0 auto}
    .pips{display:flex;gap:3px;align-items:center;justify-content:flex-end}
    .pslot{flex:0 0 18px;width:18px;height:18px;display:flex;align-items:center;justify-content:center}
    .pslot i{width:6px;height:6px;border-radius:50%;background:var(--bg);border:1px solid var(--dim2);font-style:normal;display:block}
    .pchip{border-radius:4px;overflow:hidden;background:#171a1e;box-shadow:inset 0 0 0 1px rgba(255,255,255,.12)}
    .pchip img{width:100%;height:100%;object-fit:contain}
    .pchip b{font:700 8px/1 var(--body);font-style:normal;color:var(--dim)}
    .pchip.fd{box-shadow:inset 0 0 0 1px rgba(255,255,255,.12),inset 0 -1.5px 0 var(--fade)}
    .legend{display:flex;align-items:center;gap:13px;padding:7px 14px 8px;background:#0c0e11;border-bottom:1px solid var(--line);font:500 9px/1 var(--mono);letter-spacing:.09em;text-transform:uppercase;color:var(--dim2)}
    .legend span{display:flex;align-items:center;gap:5px}
    .legend u + u{margin-left:-4px}
    .legend u{text-decoration:none;display:inline-flex;align-items:center;justify-content:center;width:16px;height:15px;border:1px solid var(--line2);border-radius:3px;background:#0d0f12;font:600 9px/1 var(--mono);color:#c4cad1}
    .legend u.on{background:var(--take);border-color:var(--take);color:#03142c}
    .legend u.onf{background:var(--fade);border-color:var(--fade);color:#2b1200}
    .legend i{font-style:normal}
    .legend b.sw{width:16px;height:8px;border-radius:2px;display:inline-block}
    .consec{padding:8px 13px 7px;background:#0c0e11;border-top:1px solid var(--line);border-bottom:1px solid var(--line);font:500 9px/1 var(--mono);letter-spacing:.13em;text-transform:uppercase;color:var(--dim);display:flex;justify-content:space-between}
    .empty{padding:40px 14px;text-align:center;font:500 12px/1.4 var(--body);color:var(--dim)}
  `;
  document.head.appendChild(style);
}

// ── Constants ───────────────────────────────────────────────────────
const SPORTS = ['All', 'NBA', 'NHL', 'MLB', 'NFL', 'EPL'];
// Soccer leagues are THREE-way (home/draw/away) everywhere the US sports are
// two-way. Gate on this set rather than `league === 'EPL'` — ShadowB-Soccer's
// config.js already has LaLiga/Serie A/Bundesliga/UCL/MLS queued behind
// `enabled: false`, and each one flips on with a config edit, not a code change.
const SOCCER_LEAGUES = new Set(['EPL', 'LALIGA', 'SERIEA', 'BUNDESLIGA', 'UCL', 'MLS']);
const isSoccer = (league) => SOCCER_LEAGUES.has(league);
// PLATFORMS is built dynamically from props data (see bookPills in App)
const LEAGUE_COLORS = { NBA: '#F97316', NHL: '#6B7280', MLB: '#1D4ED8', NFL: '#795548', EPL: '#37003C' };
const LEAGUE_TEXT = { NBA: 'white', NHL: 'white', MLB: 'white', NFL: 'white', EPL: 'white' }; // all league badges dark enough for white text
const LEAGUE_BG = { NBA: 'rgba(249,115,22,0.12)', NHL: 'rgba(107,114,128,0.12)', MLB: 'rgba(29,78,216,0.12)', NFL: 'rgba(121,85,72,0.12)', EPL: 'rgba(55,0,60,0.12)' };
const TAB_ACCENTS = {
  picks: { gradient: 'linear-gradient(135deg, #059669 0%, #10B981 50%, #064E3B 100%)', accent: '#10B981', glow: 'rgba(16,185,129,0.3)' },
  scores: { gradient: 'linear-gradient(135deg, #2563EB 0%, #3B82F6 50%, #1E3A5F 100%)', accent: '#3B82F6', glow: 'rgba(59,130,246,0.3)' },
  props: { gradient: 'linear-gradient(135deg, #7C3AED 0%, #8B5CF6 50%, #4C1D95 100%)', accent: '#8B5CF6', glow: 'rgba(139,92,246,0.3)' },
  results: { gradient: 'linear-gradient(135deg, #D97706 0%, #F59E0B 50%, #78350F 100%)', accent: '#F59E0B', glow: 'rgba(245,158,11,0.3)' },
  settings: { gradient: 'linear-gradient(135deg, #64748B 0%, #94A3B8 50%, #334155 100%)', accent: '#94A3B8', glow: 'rgba(148,163,184,0.3)' },
};

const ESPN_SPORTS = {
  NBA: { key: 'basketball', league: 'nba' },
  NHL: { key: 'hockey', league: 'nhl' },
  MLB: { key: 'baseball', league: 'mlb' },
  NFL: { key: 'football', league: 'nfl' },
  EPL: { key: 'soccer', league: 'eng.1' },
};

// ── Team Logos ──────────────────────────────────────────────────────
const TEAM_CODES = {
  // EPL (ESPN soccer numeric ids)
  'Arsenal': '359', 'Aston Villa': '362', 'AFC Bournemouth': '349', 'Brentford': '337',
  'Brighton & Hove Albion': '331', 'Burnley': '379', 'Chelsea': '363', 'Crystal Palace': '384',
  'Everton': '368', 'Fulham': '370', 'Leeds United': '357', 'Liverpool': '364',
  'Manchester City': '382', 'Manchester United': '360', 'Newcastle United': '361',
  'Nottingham Forest': '393', 'Sunderland': '366', 'Tottenham Hotspur': '367',
  'West Ham United': '371', 'Wolverhampton Wanderers': '380',
  // NBA
  'Atlanta Hawks': 'atl', 'Boston Celtics': 'bos', 'Brooklyn Nets': 'bkn', 'Charlotte Hornets': 'cha', 'Chicago Bulls': 'chi',
  'Cleveland Cavaliers': 'cle', 'Dallas Mavericks': 'dal', 'Denver Nuggets': 'den', 'Detroit Pistons': 'det', 'Golden State Warriors': 'gs',
  'Houston Rockets': 'hou', 'Los Angeles Clippers': 'lac', 'Los Angeles Lakers': 'lal', 'Memphis Grizzlies': 'mem', 'Miami Heat': 'mia',
  'Milwaukee Bucks': 'mil', 'Minnesota Timberwolves': 'min', 'New Orleans Pelicans': 'no', 'New York Knicks': 'ny', 'Oklahoma City Thunder': 'okc',
  'Orlando Magic': 'orl', 'Philadelphia 76ers': 'phi', 'Phoenix Suns': 'phx', 'Portland Trail Blazers': 'por', 'Sacramento Kings': 'sac',
  'San Antonio Spurs': 'sa', 'Toronto Raptors': 'tor', 'Utah Jazz': 'utah', 'Washington Wizards': 'wsh',
  // NHL
  'Anaheim Ducks': 'ana', 'Arizona Coyotes': 'ari', 'Boston Bruins': 'bos', 'Buffalo Sabres': 'buf', 'Calgary Flames': 'cgy',
  'Carolina Hurricanes': 'car', 'Chicago Blackhawks': 'chi', 'Colorado Avalanche': 'col', 'Columbus Blue Jackets': 'cbj', 'Dallas Stars': 'dal',
  'Detroit Red Wings': 'det', 'Edmonton Oilers': 'edm', 'Florida Panthers': 'fla', 'Los Angeles Kings': 'la', 'Minnesota Wild': 'min',
  'Montreal Canadiens': 'mtl', 'Nashville Predators': 'nsh', 'New Jersey Devils': 'nj', 'New York Islanders': 'nyi', 'New York Rangers': 'nyr',
  'Ottawa Senators': 'ott', 'Philadelphia Flyers': 'phi', 'Pittsburgh Penguins': 'pit', 'San Jose Sharks': 'sj', 'Seattle Kraken': 'sea',
  'St. Louis Blues': 'stl', 'Tampa Bay Lightning': 'tb', 'Toronto Maple Leafs': 'tor', 'Vancouver Canucks': 'van', 'Vegas Golden Knights': 'vgk',
  'Washington Capitals': 'wsh', 'Winnipeg Jets': 'wpg',
  // MLB
  'Arizona Diamondbacks': 'ari', 'Atlanta Braves': 'atl', 'Baltimore Orioles': 'bal', 'Boston Red Sox': 'bos', 'Chicago Cubs': 'chc',
  'Chicago White Sox': 'cws', 'Cincinnati Reds': 'cin', 'Cleveland Guardians': 'cle', 'Colorado Rockies': 'col', 'Detroit Tigers': 'det',
  'Houston Astros': 'hou', 'Kansas City Royals': 'kc', 'Los Angeles Angels': 'laa', 'Los Angeles Dodgers': 'lad', 'Miami Marlins': 'mia',
  'Milwaukee Brewers': 'mil', 'Minnesota Twins': 'min', 'New York Mets': 'nym', 'New York Yankees': 'nyy', 'Oakland Athletics': 'ath', 'Athletics': 'ath',
  'Philadelphia Phillies': 'phi', 'Pittsburgh Pirates': 'pit', 'San Diego Padres': 'sd', 'San Francisco Giants': 'sf', 'Seattle Mariners': 'sea',
  'St. Louis Cardinals': 'stl', 'Tampa Bay Rays': 'tb', 'Texas Rangers': 'tex', 'Toronto Blue Jays': 'tor', 'Washington Nationals': 'wsh',
  // NFL
  'Arizona Cardinals': 'ari', 'Atlanta Falcons': 'atl', 'Baltimore Ravens': 'bal', 'Buffalo Bills': 'buf', 'Carolina Panthers': 'car',
  'Chicago Bears': 'chi', 'Cincinnati Bengals': 'cin', 'Cleveland Browns': 'cle', 'Dallas Cowboys': 'dal', 'Denver Broncos': 'den',
  'Detroit Lions': 'det', 'Green Bay Packers': 'gb', 'Houston Texans': 'hou', 'Indianapolis Colts': 'ind', 'Jacksonville Jaguars': 'jax',
  'Kansas City Chiefs': 'kc', 'Las Vegas Raiders': 'lv', 'Los Angeles Chargers': 'lac', 'Los Angeles Rams': 'lar', 'Miami Dolphins': 'mia',
  'Minnesota Vikings': 'min', 'New England Patriots': 'ne', 'New Orleans Saints': 'no', 'New York Giants': 'nyg', 'New York Jets': 'nyj',
  'Philadelphia Eagles': 'phi', 'Pittsburgh Steelers': 'pit', 'San Francisco 49ers': 'sf', 'Seattle Seahawks': 'sea', 'Tampa Bay Buccaneers': 'tb',
  'Tennessee Titans': 'ten', 'Washington Commanders': 'wsh',
};

// ── Helpers ─────────────────────────────────────────────────────────
const fmt = (odds) => (odds > 0 ? `+${odds}` : `${odds}`);
const confColor = (c) => { const n = parseFloat(c) || 0; return n >= 8 ? '#34D399' : n >= 6 ? '#F59E0B' : '#64748B'; };
const confBg = (c) => { const n = parseFloat(c) || 0; return n >= 8 ? 'rgba(16,185,129,0.15)' : n >= 6 ? 'rgba(245,158,11,0.15)' : 'rgba(255,255,255,0.08)'; };

function teamLogo(teamName, league) {
  const code = TEAM_CODES[teamName];
  if (!code) return null;
  const sport = { NBA: 'nba', NHL: 'nhl', MLB: 'mlb', NFL: 'nfl', EPL: 'soccer' }[league] || 'nba';
  return `https://a.espncdn.com/i/teamlogos/${sport}/500/${code}.png`;
}

function cleanTime(period, showDate = false) {
  if (!period) return '';
  // Handle ISO dates (from startTime field)
  if (period.includes('T') && period.includes('-')) {
    try {
      const d = new Date(period);
      if (isNaN(d.getTime())) return '';
      const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
      if (!showDate) return time;
      // "This Week" mixes multiple days together — prefix with a short date so
      // it's clear which day a game card belongs to.
      const day = d.toLocaleDateString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric' });
      return `${day}, ${time}`;
    } catch (e) { return ''; }
  }
  // Clean ESPN shortDetail format
  let cleaned = period.replace(/ 0:00$/, '').replace(/ 0\.0$/, '');
  // Strip leading date like "4/2 - "
  cleaned = cleaned.replace(/^\d+\/\d+\s*-\s*/, '');
  return cleaned.trim();
}

function dedup(picks) {
  const seen = {};
  const result = [];
  for (const p of picks) {
    const key = `${p.away}|${p.home}|${(p.betType || p.market || '').toLowerCase()}|${p.pick}|${p.line}`;
    if (!seen[key]) {
      seen[key] = true;
      result.push(p);
    }
  }
  return result;
}

function getPickStatus(pick, game) {
  if (!game || game.status === 'pre') return 'pending';
  if (!game.awayScore && game.awayScore !== 0) return 'pending';
  const aS = game.awayScore, hS = game.homeScore;
  const bt = pick.betType?.toLowerCase() || pick.market?.toLowerCase();
  if (bt === 'moneyline') {
    const pickTeam = (pick.pick || '').toLowerCase();
    const home = (game.home || '').toLowerCase();
    const away = (game.away || '').toLowerCase();
    if (isSoccer(pick.league)) {
      // 3-way: Draw is a real outcome, not a push.
      const level = aS === hS;
      if (pickTeam === 'draw') return level ? 'winning' : 'losing';
      const pickedHomeE = pickTeam.includes(home) || home.includes(pickTeam);
      if (level) return 'losing';
      return pickedHomeE ? (hS > aS ? 'winning' : 'losing') : (aS > hS ? 'winning' : 'losing');
    }
    if (aS === hS) return 'even';
    const pickedHome = pickTeam.includes(home) || home.includes(pickTeam);
    if (pickedHome) return hS > aS ? 'winning' : 'losing';
    return aS > hS ? 'winning' : 'losing';
  }
  if (bt === 'spread') {
    const line = parseFloat(pick.line) || 0;
    const pickTeam = (pick.pick || '').toLowerCase();
    const home = (game.home || '').toLowerCase();
    const isHome = pickTeam.includes(home) || home.includes(pickTeam);
    const margin = isHome ? (hS + line) - aS : (aS + line) - hS;
    return margin > 0 ? 'winning' : margin < 0 ? 'losing' : 'even';
  }
  if (bt === 'total') {
    const total = aS + hS;
    const line = parseFloat(pick.line) || 0;
    const isOver = pick.pick?.toLowerCase().includes('over');
    if (isOver) return total > line ? 'winning' : total < line ? 'losing' : 'even';
    return total < line ? 'winning' : total > line ? 'losing' : 'even';
  }
  return 'pending';
}

function getTrend(picks, game) {
  if (!picks.length || !game || game.status === 'pre') return null;
  let score = 0;
  for (const p of picks) {
    const s = getEffectiveStatus(p, game);
    score += s === 'winning' ? 1 : s === 'losing' ? -1 : 0;
  }
  return score / picks.length;
}

// Pace-aware LIVE read (only meaningful when game.status === 'in').
// Returns: 'clinched-win' | 'good' | 'neutral' | 'bad' | 'clinched-loss'.
// Moneyline/spread read directly off the current margin (meaningful even early).
// Totals project the finish from pace and stay 'neutral' until enough of the
// game has elapsed — so a total isn't called a miss just because the score is
// low early (e.g. Over 8.5 at 1-0 in the 1st reads "too early", not a loss).
function getLiveState(pick, game) {
  if (!game || game.awayScore == null || game.homeScore == null) return 'neutral';
  const aS = game.awayScore, hS = game.homeScore;
  const bt = (pick.betType || pick.market || '').toLowerCase();
  const pickTeam = (pick.pick || '').toLowerCase();
  const home = (game.home || '').toLowerCase();
  const pickedHome = pickTeam.includes(home) || home.includes(pickTeam);

  if (bt === 'moneyline') {
    // Soccer is 3-way: a "Draw" pick trends well while level, poorly once someone leads.
    if (isSoccer(pick.league) && pickTeam === 'draw') return aS === hS ? 'good' : 'bad';
    if (aS === hS) return 'neutral';
    const leadOwn = pickedHome ? hS - aS : aS - hS;
    return leadOwn > 0 ? 'good' : 'bad';
  }
  if (bt === 'spread') {
    const line = parseFloat(pick.line) || 0;
    const margin = pickedHome ? (hS + line) - aS : (aS + line) - hS; // >0 = covering
    if (Math.abs(margin) < 0.5) return 'neutral';
    return margin > 0 ? 'good' : 'bad';
  }
  if (bt === 'total') {
    const total = aS + hS;
    const line = parseFloat(pick.line) || 0;
    const isOver = pickTeam.includes('over');
    // Mathematical clinch — the score only goes up, so once past the line it's settled.
    if (isOver && total > line) return 'clinched-win';
    if (!isOver && total >= line) return 'clinched-loss';
    const elapsed = getGameProgress(game); // 0..~0.98
    const MIN_READ = 0.25; // no confident call before ~25% of the game
    if (elapsed < MIN_READ) return 'neutral';
    const projected = total / elapsed; // linear pace projection
    const cushion = 0.10;               // 10% buffer to avoid flip-flopping
    if (isOver) {
      if (projected >= line * (1 + cushion)) return 'good';
      if (projected <= line * (1 - cushion) && elapsed >= 0.4) return 'bad';
      return 'neutral';
    }
    if (projected <= line * (1 - cushion)) return 'good';
    if (projected >= line * (1 + cushion) && elapsed >= 0.4) return 'bad';
    return 'neutral';
  }
  return 'neutral';
}

// Unified status for tallies/counters: pace-aware while live, definitive when final.
function getEffectiveStatus(pick, game) {
  if (game && game.status === 'in') {
    const s = getLiveState(pick, game);
    if (s === 'good' || s === 'clinched-win') return 'winning';
    if (s === 'bad' || s === 'clinched-loss') return 'losing';
    return 'even'; // neutral / too early
  }
  return getPickStatus(pick, game);
}

// Dot/accent color for a pick: green/red/amber while live, green/red/gray when final.
function pickColor(pick, game) {
  if (game && game.status === 'in') {
    const s = getLiveState(pick, game);
    if (s === 'good' || s === 'clinched-win') return '#34D399';
    if (s === 'bad' || s === 'clinched-loss') return '#F87171';
    return '#F59E0B'; // neutral / too early
  }
  const r = getPickStatus(pick, game);
  return r === 'winning' ? '#34D399' : r === 'losing' ? '#F87171' : '#64748B';
}

// Icon node next to a pick: colored circle while live (✓/✗ once clinched),
// emoji only once the game is final.
function statusIcon(pick, game) {
  if (game && game.status === 'in') {
    const s = getLiveState(pick, game);
    if (s === 'clinched-win') return <span style={{ color: '#34D399', fontWeight: 900 }}>✓</span>;
    if (s === 'clinched-loss') return <span style={{ color: '#F87171', fontWeight: 900 }}>✗</span>;
    const c = s === 'good' ? '#34D399' : s === 'bad' ? '#F87171' : '#F59E0B';
    return <span style={{ display: 'inline-block', width: 11, height: 11, borderRadius: '50%', background: c }} />;
  }
  const r = getPickStatus(pick, game);
  return r === 'winning' ? '✅' : r === 'losing' ? '❌' : '➖';
}

function sortGames(games) {
  const stateOrder = { in: 0, post: 2, pre: 3 };
  const leagueOrder = { NBA: 0, NHL: 1, MLB: 2, NFL: 3, EPL: 4 };
  return [...games].sort((a, b) => {
    // Close games always first
    const aClose = a.status === 'in' && a.isLate && Math.abs(a.awayScore - a.homeScore) <= 5;
    const bClose = b.status === 'in' && b.isLate && Math.abs(b.awayScore - b.homeScore) <= 5;
    if (aClose && !bClose) return -1;
    if (!aClose && bClose) return 1;
    // Then by game state (live > post > pre)
    const aOrd = stateOrder[a.status] ?? 4;
    const bOrd = stateOrder[b.status] ?? 4;
    if (aOrd !== bOrd) return aOrd - bOrd;
    // Then by start time
    const aTime = a.gameDate ? new Date(a.gameDate).getTime() : 0;
    const bTime = b.gameDate ? new Date(b.gameDate).getTime() : 0;
    if (aTime !== bTime) return aTime - bTime;
    // Then by sport
    const aL = leagueOrder[a.league] ?? 9;
    const bL = leagueOrder[b.league] ?? 9;
    return aL - bL;
  });
}


// ── Game Progress (0-1) for progress bar ────────────────────────────
function getGameProgress(game) {
  if (!game || game.status === 'pre') return 0;
  if (game.status === 'post' || game.status === 'postponed') return 1;
  const pNum = game.periodNum || 0;
  const totalPeriods = isSoccer(game.league) ? 2 : ({ NBA: 4, NHL: 3, NFL: 4, MLB: 9 }[game.league] || 4);
  // pNum is 1-indexed current period; for MLB "Top 5th" = period 5
  // Base progress = completed periods / total
  const base = Math.max(0, (pNum - 1)) / totalPeriods;
  // Add partial credit (~half of current period)
  const partial = 0.5 / totalPeriods;
  return Math.min(base + partial, 0.98); // never fully 1 while live
}

// ── Tape design: tier + shared game-matching helpers ─────────────────
// Tier buckets map onto the same confidence thresholds the old UI already
// used for its green/amber/gray dot (n>=8 / n>=6 / else) — see confColor.
function tierOf(pick) {
  const n = parseFloat(pick.confidence) || 0;
  return n >= 8 ? 10 : n >= 6 ? 7 : 5;
}
function tierHeightClass(tier) { return tier === 10 ? 't10' : tier === 7 ? 't7' : 't5'; }

function calcProfit(odds, units) {
  if (!odds || !units) return 0;
  return odds > 0 ? units * (odds / 100) : units * (100 / Math.abs(odds));
}

// myBets pick-entries are either a plain string ('pass', or legacy 'bet'/'fade'
// from before stake stamping) or a stamped object { state, stakeUsed, at }.
// Every reader has to accept both shapes.
const entryState = (v) => (typeof v === 'string' ? v : v && v.state);
// Which of home/draw/away you put yourself on (3-way soccer moneylines only).
// Undefined on every US-sports entry and on anything saved before 2026-08-28 —
// callers fall back to the model's own side, which is the pre-existing behaviour.
const entrySide = (v) => (v && typeof v === 'object' ? v.side : undefined);
const entryStake = (v, p) => (v && typeof v === 'object' && v.stakeUsed != null)
  ? v.stakeUsed
  : (p.units || 0); // legacy/pre-stamp bet: fall back to model units

// Doubleheader-aware game matching, shared by the Picks (watch mode) and
// Scores tapes so a pick always resolves to the correct sibling game.
function buildMatchupGames(liveGames) {
  const matchupGames = {};
  for (const g of liveGames) {
    const mk = `${g.league}|${g.away}@${g.home}`;
    if (!matchupGames[mk]) matchupGames[mk] = [];
    matchupGames[mk].push(g);
  }
  for (const mk of Object.keys(matchupGames)) {
    matchupGames[mk].sort((a, b) => (a.gameDate || '').localeCompare(b.gameDate || ''));
  }
  return matchupGames;
}
function pickBelongsToGame(matchupGames, p, game) {
  const siblings = matchupGames[`${game.league}|${game.away}@${game.home}`] || [];
  if (siblings.length < 2) return true;
  const t = Date.parse(p.startTime || '');
  let target = null;
  if (isNaN(t)) {
    target = siblings[0];
  } else {
    let bestDiff = Infinity;
    for (const s of siblings) {
      const st = Date.parse(s.gameDate || '');
      if (isNaN(st)) continue;
      const diff = Math.abs(st - t);
      if (diff < bestDiff) { bestDiff = diff; target = s; }
    }
    if (!target) target = siblings[0];
  }
  return target === game;
}
function findGameForPick(liveGames, matchupGames, p) {
  const candidates = liveGames.filter(g => g.league === p.league && g.away === p.away && g.home === p.home);
  if (candidates.length <= 1) return candidates[0] || null;
  return candidates.find(g => pickBelongsToGame(matchupGames, p, g)) || candidates[0];
}

// Pick/prop identity keys — shared by App's myBets store and the tape tabs.
const pickKey = (p) => `${p.league}|${p.away}|${p.home}|${(p.betType||p.market||'').toLowerCase()}|${p.pick}|${p.line}`;
const propKey = (p) => `prop|${p.league}|${p.player}|${p.market}|${p.direction}|${p.book}`;

// ── Filter Pills ────────────────────────────────────────────────────
function Pills({ items, active, onChange, color = '#1F2937' }) {
  return (
    <div style={{ display: 'flex', gap: 6, overflowX: 'auto', padding: '5px 0', WebkitOverflowScrolling: 'touch' }}>
      {items.map(item => (
        <button key={item} onClick={() => onChange(item)} style={{
          padding: '4px 14px', borderRadius: 20,
          border: active === item ? `2px solid ${color}` : '1.5px solid rgba(255,255,255,0.12)',
          background: active === item ? color : 'transparent',
          color: active === item ? 'white' : '#94A3B8',
          fontSize: 12, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap',
        }}>{item}</button>
      ))}
    </div>
  );
}

// ── Team Logo Component ──────────────────────────────────────────────
function TeamLogo({ team, league, size = 20 }) {
  const url = teamLogo(team, league);
  if (!url) return null;
  return <img src={url} alt="" style={{ width: size, height: size, objectFit: 'contain' }} />;
}

// ── Best Bets Section ───────────────────────────────────────────────
function BestBets({ picks }) {
  const topPicks = [...picks].filter(p => p.units >= 0.15).sort((a, b) => b.units - a.units).slice(0, 5);
  if (!topPicks.length) return null;

  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 13, fontWeight: 800, color: '#F1F5F9', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontSize: 14 }}>🔥</span> Top Plays
      </div>
      {topPicks.map((p, i) => (
        <div key={i} style={{
          background: 'linear-gradient(135deg, #111827 0%, #1E293B 100%)', borderRadius: 10, marginBottom: 6, padding: '10px 12px',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderLeft: '3px solid #10B981',
        }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 2 }}>
              <span style={{ background: LEAGUE_COLORS[p.league] || '#6B7280', color: LEAGUE_TEXT[p.league] || 'white', fontSize: 9, fontWeight: 700, padding: '2px 5px', borderRadius: 3 }}>{p.league}</span>
              <span style={{ fontSize: 10, color: '#64748B', fontWeight: 600, textTransform: 'uppercase' }}>{p.betType || p.market}</span>
            </div>
            <div style={{ fontSize: 14, fontWeight: 700, color: 'white' }}>{p.pick} <span style={{ color: '#34D399', fontWeight: 800 }}>{fmt(p.odds)}</span></div>
            <div style={{ fontSize: 10, color: '#64748B', display: 'flex', alignItems: 'center', gap: 6 }}>
              <TeamLogo team={p.away} league={p.league} size={14} />
              <span>{p.away} @ {p.home}</span>
              <TeamLogo team={p.home} league={p.league} size={14} />
            </div>
          </div>
          <div style={{ textAlign: 'right', flexShrink: 0, marginLeft: 10 }}>
            <div style={{ fontSize: 18, fontWeight: 900, color: '#34D399' }}>{p.units}u</div>
            <span style={{ fontSize: 10, fontWeight: 700, color: confColor(p.confidence), background: confBg(p.confidence), padding: '1px 6px', borderRadius: 10 }}>{String(p.confidence).replace('%', '')}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Morning Summary Card ────────────────────────────────────────────
function MorningSummary({ picks, isBet, isFade, onLockAll }) {
  const qualifiedPicks = picks.filter(p => p.units >= 0.2);
  const totalPlays = picks.length;
  const totalUnits = picks.reduce((s, p) => s + (p.units || 0), 0);
  const lockedCount = picks.filter(p => isBet(p)).length;
  const fadedCount = picks.filter(p => isFade(p)).length;
  const unlockedQualified = qualifiedPicks.filter(p => !isBet(p) && !isFade(p)).length;
  const leagueCounts = {};
  for (const p of picks) { leagueCounts[p.league] = (leagueCounts[p.league] || 0) + 1; }

  return (
    <div style={{ background: 'linear-gradient(135deg, rgba(16,185,129,0.08) 0%, rgba(5,150,105,0.04) 100%)', borderRadius: 12, padding: '12px 14px', marginBottom: 10, border: '1px solid rgba(16,185,129,0.15)', boxShadow: '0 2px 8px rgba(0,0,0,0.3)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <div style={{ fontSize: 13, fontWeight: 800, color: '#F1F5F9' }}>Today's Slate</div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {Object.entries(leagueCounts).map(([lg, ct]) => (
            <span key={lg} style={{ fontSize: 9, fontWeight: 700, color: LEAGUE_TEXT[lg] || 'white', background: LEAGUE_COLORS[lg] || '#6B7280', padding: '2px 6px', borderRadius: 4 }}>{lg} {ct}</span>
          ))}
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6, marginBottom: 10, textAlign: 'center' }}>
        <div><div style={{ fontSize: 20, fontWeight: 900, color: '#F1F5F9' }}>{totalPlays}</div><div style={{ fontSize: 9, color: '#64748B', fontWeight: 600 }}>PLAYS</div></div>
        <div><div style={{ fontSize: 20, fontWeight: 900, color: '#10B981' }}>{totalUnits.toFixed(1)}u</div><div style={{ fontSize: 9, color: '#64748B', fontWeight: 600 }}>AT RISK</div></div>
        <div><div style={{ fontSize: 20, fontWeight: 900, color: '#4B9CD3' }}>{lockedCount}{fadedCount > 0 ? <span style={{ color: '#FFC72C', fontSize: 14 }}>/{fadedCount}</span> : ''}</div><div style={{ fontSize: 9, color: '#64748B', fontWeight: 600 }}>{fadedCount > 0 ? 'LOCKED/FADED' : 'LOCKED'}</div></div>
      </div>
      {unlockedQualified > 0 && (
        <button onClick={onLockAll} style={{
          width: '100%', padding: '10px 0', borderRadius: 8, border: '2px solid rgba(16,185,129,0.4)',
          background: 'linear-gradient(135deg, rgba(16,185,129,0.2) 0%, rgba(5,150,105,0.15) 100%)',
          color: '#34D399', fontSize: 13, fontWeight: 800, cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
        }}>
          <span style={{ fontSize: 16 }}>⚡</span> Lock All 0.2u+ ({unlockedQualified} picks)
        </button>
      )}
      {unlockedQualified === 0 && lockedCount > 0 && (
        <div style={{ textAlign: 'center', fontSize: 11, color: '#34D399', fontWeight: 700, padding: '4px 0' }}>All qualified picks locked in</div>
      )}
    </div>
  );
}

// ── Picks Tab (Direction A — Tape) ───────────────────────────────────
// Build mode: triage the morning slate with the rule bar + tri-state rows.
// Watch mode: same tape, locked — price/live-P&L/progress replace the tri-state.
function PicksTab({ picks, liveGames, myBets, setMyBets, isBet, isFade, toggleBet, setPickState, displayPick, pickMode, setPickMode, tierThreshold, setTierThreshold, picksDateFilter, setPicksDateFilter, showDate, lastUpdated, commitSnapshot, committedCount, committedUnits, undoLeft, commitTake: commitTakeApp, undoCommit, stake, sizing, setSizing, sizingPresets }) {
  const [sf, setSf] = useState('All');
  const [sortDesc, setSortDesc] = useState(false);
  const [minUnitOn, setMinUnitOn] = useState(false);
  const [expandedGames, setExpandedGames] = useState({});
  const dragRef = useRef(null);

  const allPicks = dedup(picks);
  const pool = minUnitOn ? allPicks.filter(p => p.units >= 0.3) : allPicks;

  // Effective state: an explicit manual tri-state tap always wins ('pass'
  // included — it's how you exclude a pick the threshold rule auto-selected);
  // otherwise the rule default (take if tier >= threshold, else pass). This
  // is both what the tri-state row displays and what "Take" commits.
  const effState = (p) => {
    const manual = entryState(myBets.get(pickKey(p)));
    if (manual === 'pass') return 'pass';
    if (manual === 'fade') return 'fade';
    if (manual === 'bet') return 'take';
    return tierOf(p) >= tierThreshold ? 'take' : 'pass';
  };

  const commitList = pool.filter(p => effState(p) === 'take');
  const commitCount = commitList.length;
  const commitUnits = commitList.reduce((s, p) => s + stake(p), 0);
  const lockedCount = pickMode === 'build' ? commitCount : pool.filter(p => isBet(p) || isFade(p)).length;

  const leagueCounts = {};
  for (const p of allPicks) leagueCounts[p.league] = (leagueCounts[p.league] || 0) + 1;
  const leagues = Object.keys(leagueCounts).sort((a, b) => leagueCounts[b] - leagueCounts[a]);

  // Rule bar segment counts (tier 10 / 7 / 5) respect the min-unit rule
  // (0.3u+) but still ignore the league filter — the rule bar describes the
  // whole (min-unit-filtered) slate, not the visible slice.
  const segCount = (t) => pool.filter(p => tierOf(p) === t).length;

  const commitTake = () => commitTakeApp(commitList);

  // ── Watch mode: derive positions, live P/L, tape-bar proportions ──────
  const positions = pool.filter(p => isBet(p) || isFade(p));
  const matchupGames = buildMatchupGames(liveGames);
  const posWithGame = positions.map(p => ({ p, game: findGameForPick(liveGames, matchupGames, p) }));
  let winU = 0, loseU = 0, liveN = 0, finalOrLiveN = 0;
  const tape = { win: 0, mid: 0, loss: 0, pre: 0 }; // unit sums, not position counts — see fix #9
  for (const { p, game } of posWithGame) {
    const display = displayPick(p, allPicks);
    if (!game || game.status === 'pre') { tape.pre += stake(p); continue; }
    finalOrLiveN++;
    if (game.status === 'in') liveN++;
    const status = getEffectiveStatus(display, game);
    const pl = status === 'winning' ? calcProfit(display.odds, stake(p)) : status === 'losing' ? -stake(p) : 0;
    if (status === 'winning') { winU += pl; tape.win += stake(p); }
    else if (status === 'losing') { loseU += stake(p); tape.loss += stake(p); }
    else tape.mid += stake(p);
  }
  const dayPL = winU - loseU;
  const tapeTotal = Math.max(positions.reduce((s, p) => s + stake(p), 0), 0.01);
  const tapePct = { win: tape.win / tapeTotal * 100, mid: tape.mid / tapeTotal * 100, loss: tape.loss / tapeTotal * 100, pre: tape.pre / tapeTotal * 100 };

  const runLabel = lastUpdated
    ? `REFRESHED ${lastUpdated.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).toUpperCase()}`
    : 'LOADING…';
  const dayLabel = new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }).toUpperCase();

  // ── Grouping into games (shared by both modes) ────────────────────────
  const visible = (sf === 'All' ? pool : pool.filter(p => p.league === sf))
    .filter(p => pickMode === 'build' || isBet(p) || isFade(p));
  const games = {};
  for (const p of visible) {
    const k = `${p.league}|${p.away}@${p.home}|${p.startTime || ''}`;
    if (!games[k]) games[k] = { league: p.league, away: p.away, home: p.home, startTime: p.startTime, picks: [] };
    games[k].picks.push(p);
  }
  let gameList = Object.values(games);
  gameList.sort((a, b) => {
    if (sortDesc) {
      const ua = Math.max(...a.picks.map(p => p.units || 0));
      const ub = Math.max(...b.picks.map(p => p.units || 0));
      return ub - ua;
    }
    const sa = a.startTime || '', sb = b.startTime || '';
    if (!sa) return 1;
    if (!sb) return -1;
    return sa.localeCompare(sb);
  });

  const marketMeta = (p) => {
    const bt = (p.betType || p.market || '').toLowerCase();
    const code = bt === 'moneyline' ? 'ML' : bt === 'spread' ? 'SPR' : 'TOT';
    const isTotal = bt === 'total';
    const isOver = isTotal && (p.pick || '').toLowerCase().includes('over');
    return { code, isTotal, isOver };
  };
  const teamChip = (name, league, small) => {
    const url = teamLogo(name, league);
    return (
      <span className="tm" style={small ? { width: 22, height: 22 } : undefined}>
        {url ? <img src={url} alt="" /> : <span style={{ fontSize: 8, fontWeight: 700, color: 'var(--dim)' }}>{(name || '').slice(0, 3).toUpperCase()}</span>}
      </span>
    );
  };
  const ouChip = (isOver) => (
    <span className="tm ou">{isOver ? '▲' : '▼'}</span>
  );
  // The draw has no crest to show, so it gets the "level" glyph rather than
  // teamChip's 3-letter fallback (which would render a meaningless "DRA").
  const drawChip = () => <span className="tm ou">=</span>;
  const sideChip = (display, p, isTotal, isOver) => (
    isTotal ? ouChip(isOver) : isDrawPick(display) ? drawChip() : teamChip(display.pick, p.league)
  );

  const renderBuildRow = (p, idx) => {
    const eff = effState(p);
    const faded = eff === 'fade';
    const selected = eff === 'take';
    const display = displayPick(p, allPicks);
    const { code, isTotal, isOver } = marketMeta(display);
    const tier = tierOf(p);
    const state = faded ? 'F' : selected ? 'T' : '-';
    // Tapping the button that already matches the effective state clears the
    // manual override (reverts to whatever the threshold rule says); tapping
    // any other button sets an explicit override — 'pass' included, so a
    // rule-auto-selected pick can actually be excluded, not just left alone.
    const manual = entryState(myBets.get(pickKey(p)));
    const tap = (val) => setPickState(p, manual === val ? null : val);

    // A soccer moneyline has three outcomes, so its control names the OUTCOMES
    // (– H D A) instead of the two-way actions (– ✓ F). The model's own side
    // carries a marker dot; tapping it means you're with the model, tapping any
    // other means you're fading to that side. This is what makes the draw always
    // reachable — including the awkward case where the draw IS the model's pick,
    // which needs no special handling here: D simply wears the marker and H/A
    // become the two fade options.
    const threeWay = isThreeWay(p);
    const mSide = threeWay ? modelSide(p) : null;
    const selSide = threeWay && eff !== 'pass' ? (entrySide(myBets.get(pickKey(p))) || mSide) : null;
    const tapSide = (sd) => {
      const want = sd === mSide ? 'bet' : 'fade';
      if (manual === want && selSide === sd) setPickState(p, null);
      else setPickState(p, want, sd);
    };

    return (
      <div key={pickKey(p) + idx} className={`r${idx === 0 ? ' first' : ''}${selected ? ' take' : ''}${faded ? ' fade' : ''}${threeWay ? ' q3' : ''}`}>
        <b className={`tick ${tierHeightClass(tier)}`}></b>
        <div className="rm">
          <span className="mkt">{code}</span>
          {sideChip(display, p, isTotal, isOver)}
          {/* Two-way rows spell out what you're fading. Three-way rows don't: the
              name column is ~64px on a phone, so "Draw · fading Chelsea" just
              ellipses into noise — and the control right there already marks the
              model's side with a dot, which is the same information, legibly. */}
          <span className="side">{display.pick}{display.line ? ` ${display.line}` : ''}{faded && !threeWay && <i> · fading {p.pick}</i>}</span>
        </div>
        {sizing === 'model'
          ? <span className="u num">{(p.units || 0).toFixed(2)}<em>u</em></span>
          : <span className="u num conv">{(p.units || 0).toFixed(2)}</span>}
        <span className="p num">{fmt(display.odds)}</span>
        {threeWay ? (
          <div className="tri quad">
            <s className={state === '-' ? 'on' : ''} onClick={() => tap('pass')}>–</s>
            {SIDES.map(sd => {
              // No price for a side means we genuinely don't have it (pre-migration
              // row, or a match the feed never quoted 3-way). Show it dead rather
              // than let anyone bet against a number we made up.
              const avail = sideAvailable(p, sd);
              const cls = [
                selSide === sd ? (sd === mSide ? 'on' : 'onf') : '',
                sd === mSide ? 'mdl' : '',
                avail ? '' : 'off',
              ].filter(Boolean).join(' ');
              return (
                <s key={sd} className={cls} title={avail ? `${sideLabel(p, sd)} ${fmt(sidePrice(p, sd))}` : 'no price for this side'}
                   onClick={avail ? () => tapSide(sd) : undefined}>{sd[0].toUpperCase()}</s>
              );
            })}
          </div>
        ) : (
          <div className="tri">
            <s className={state === '-' ? 'on' : ''} onClick={() => tap('pass')}>–</s>
            <s className={state === 'T' ? 'on' : ''} onClick={() => tap('bet')}>✓</s>
            <s className={state === 'F' ? 'onf' : ''} onClick={() => tap('fade')}>F</s>
          </div>
        )}
      </div>
    );
  };

  const renderWatchRow = (p, idx) => {
    const faded = isFade(p);
    const display = displayPick(p, allPicks);
    const { code, isTotal, isOver } = marketMeta(display);
    const tier = tierOf(p);
    const game = findGameForPick(liveGames, matchupGames, p);
    const isPre = !game || game.status === 'pre';
    const status = game ? getEffectiveStatus(display, game) : 'pending';
    const pl = status === 'winning' ? calcProfit(display.odds, stake(p)) : status === 'losing' ? -stake(p) : 0;
    const plCls = isPre ? 'fl' : status === 'winning' ? 'up' : status === 'losing' ? 'dn' : 'fl';
    return (
      <div key={pickKey(p) + idx} className={`r locked${idx === 0 ? ' first' : ''}${!faded ? ' take' : ' fade'}`}>
        <b className={`tick ${tierHeightClass(tier)}`}></b>
        <div className="rm">
          <span className="mkt">{code}</span>
          {sideChip(display, p, isTotal, isOver)}
          <span className="side">{display.pick}{display.line ? ` ${display.line}` : ''}{faded && <i> · {status === 'winning' ? 'fade won' : 'fade'}</i>}</span>
        </div>
        <span className="p num">{fmt(display.odds)}</span>
        {isPre
          ? <span className="apnl fl num">{stake(p).toFixed(2)}<em>u</em></span>
          : <span className={`apnl ${plCls} num`}>{pl >= 0 ? '+' : ''}{pl.toFixed(2)}<em>u</em></span>}
        <div className="clockbar"><b style={{ width: `${Math.round(getGameProgress(game) * 100)}%` }}></b></div>
      </div>
    );
  };

  return (
    <div className="tp">
      <div className="ah">
        <b>Shadow Bets</b>
        {pickMode === 'build'
          ? (positions.length > 0
            ? <span className="clickable" onClick={() => setPickMode('watch')}>{dayLabel} · VIEW: WATCH ▸</span>
            : <span>{dayLabel} · {runLabel}</span>)
          : <span className="clickable" onClick={() => setPickMode('build')}>{lockedCount} POSITIONS · VIEW: BUILD ▸</span>}
      </div>

      <div className="sizerow">
        <span className="sl">Sizing</span>
        <span className="seg">
          {sizingPresets.map(s => (
            <button
              key={s}
              className={sizing === s ? 'on' : ''}
              onClick={() => setSizing(s)}
            >{s === 'model' ? 'Model' : s.toFixed(2).slice(1)}</button>
          ))}
        </span>
      </div>

      {picksDateFilter && (
        <div className="datepick">
          {['Today', 'Tomorrow', 'This Week'].map(d => (
            <button key={d} className={picksDateFilter === d ? 'on' : ''} onClick={() => setPicksDateFilter(d)}>{d}</button>
          ))}
        </div>
      )}

      {pickMode === 'build' ? (
        <div className="astrip">
          <div><span className="k">Plays</span><span className="v">{allPicks.length}</span></div>
          <div><span className="k">At risk{sizing !== 'model' && <em>flat</em>}</span><span className="v">{allPicks.reduce((s, p) => s + stake(p), 0).toFixed(1)}<s>u</s></span></div>
          <div><span className="k">Locked</span><span className="v hot">{lockedCount}<s>/{allPicks.length}</s></span></div>
        </div>
      ) : (
        <div className="astrip">
          <div><span className="k">Live</span><span className="v">{liveN}<s>/{positions.length}</s></span></div>
          <div><span className="k">At risk{sizing !== 'model' && <em>flat</em>}</span><span className="v">{positions.reduce((s, p) => s + stake(p), 0).toFixed(1)}<s>u</s></span></div>
          <div><span className="k">Day P/L</span><span className={`v ${dayPL >= 0 ? 'up' : 'dn'}`}>{dayPL >= 0 ? '+' : ''}{dayPL.toFixed(2)}<s>u</s></span></div>
        </div>
      )}

      {pickMode === 'build' ? (
        <div className="arule">
          <div className="arule-top">
            <span className="lb">Rule · tier threshold</span>
            <span className="rs">commits <b>{commitCount} picks · {commitUnits.toFixed(1)}u</b></span>
          </div>
          <div
            className="ruler"
            ref={dragRef}
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              const move = (ev) => {
                const rect = dragRef.current.getBoundingClientRect();
                const frac = Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width));
                setTierThreshold(frac < 1 / 3 ? 10 : frac < 2 / 3 ? 7 : 5);
              };
              move(e);
              const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
              window.addEventListener('pointermove', move);
              window.addEventListener('pointerup', up);
            }}
          >
            {[10, 7, 5].map(t => (
              <div key={t} className={`seg${t >= tierThreshold ? ' on' : ''}`} onClick={() => setTierThreshold(t)}>
                <em>{t}</em><i>{segCount(t)} PICKS</i>
              </div>
            ))}
            <div className="handle" style={{ left: `calc(${tierThreshold === 10 ? 33.33 : tierThreshold === 7 ? 66.66 : 100}% - 1px)` }}></div>
          </div>
          <div className="arule-act">
            <button className="abtn solid" disabled={commitCount === 0} onClick={commitTake}>
              {`Take ${commitCount} · ${commitUnits.toFixed(1)}u`}
            </button>
            <button className={`abtn ghost${minUnitOn ? ' on' : ''}`} onClick={() => setMinUnitOn(v => !v)}>0.3u+</button>
          </div>
        </div>
      ) : (
        <div className="tapebar">
          <i style={{ background: 'var(--win)', width: `${tapePct.win}%` }}></i>
          <i style={{ background: 'var(--line2)', width: `${tapePct.mid}%` }}></i>
          <i style={{ background: 'var(--loss)', width: `${tapePct.loss}%` }}></i>
          <i style={{ background: 'var(--panel2)', width: `${tapePct.pre}%` }}></i>
        </div>
      )}

      {pickMode === 'watch' && (
        <div className="legend">
          <span><b className="sw" style={{ background: 'var(--win)' }}></b><i>{tape.win.toFixed(1)}u up</i></span>
          <span><b className="sw" style={{ background: 'var(--line2)' }}></b><i>{tape.mid.toFixed(1)}u even</i></span>
          <span><b className="sw" style={{ background: 'var(--loss)' }}></b><i>{tape.loss.toFixed(1)}u dn</i></span>
          <span><b className="sw" style={{ background: 'var(--panel2)', boxShadow: 'inset 0 0 0 1px var(--line2)' }}></b><i>{tape.pre.toFixed(1)}u pre</i></span>
        </div>
      )}

      {commitSnapshot && pickMode === 'watch' && (
        <div className="undobar">
          <span className="ul">Locked {committedCount} · {committedUnits.toFixed(1)}u<span className="ct">{undoLeft}s</span></span>
          <button className="ub" onClick={undoCommit}>Undo</button>
        </div>
      )}

      <div className="aleagues">
        <button className={sf === 'All' ? 'sel' : ''} onClick={() => setSf('All')}><span className="lg">ALL</span><span className="ct">{allPicks.length}</span></button>
        {leagues.map(l => (
          <button key={l} className={sf === l ? 'sel' : ''} onClick={() => setSf(l)}><span className="lg">{l}</span><span className="ct">{leagueCounts[l]}</span></button>
        ))}
        <button onClick={() => setSortDesc(v => !v)}><span className="glyph">⇅</span></button>
      </div>

      {pickMode === 'build' && (
        <div className="legend">
          <span><u>–</u><i>Pass</i></span>
          <span><u className="on">✓</u><i>Take</i></span>
          <span><u className="onf">F</u><i>Fade the model</i></span>
          <span style={{ marginLeft: 'auto' }}><i>Tick = tier</i></span>
        </div>
      )}
      {/* The –/✓/F legend above doesn't describe a soccer moneyline, whose control
          names the three outcomes instead. Only shown when such a row is on screen. */}
      {pickMode === 'build' && visible.some(isThreeWay) && (
        <div className="legend">
          <span><u className="on">H</u><u>D</u><u>A</u><i>Home · draw · away</i></span>
          <span style={{ marginLeft: 'auto' }}><i>Dot = model’s side</i></span>
        </div>
      )}

      {pickMode === 'build' && sizing !== 'model' && (
        <div className="consec">
          <span>All plays · {sizing.toFixed(2)}u each</span>
          <span>column = model units</span>
        </div>
      )}

      <div>
        {gameList.map((g, gi) => {
          const rows = [...g.picks].sort((a, b) => tierOf(b) - tierOf(a));
          const shown = pickMode === 'build' ? rows.filter((p, i) => tierOf(p) > 5 || expandedGames[gi] || rows.every(r => tierOf(r) <= 5)) : rows;
          const hidden = pickMode === 'build' ? rows.filter(p => !shown.includes(p)) : [];
          return (
            <div className="agame" key={gi}>
              <div className="agh">
                <span className="lgm">{g.league}</span>
                <span className="duo">{teamChip(g.away, g.league, true)}{teamChip(g.home, g.league, true)}</span>
                <span className="tm2">{g.away.split(' ').pop()}</span>
                <span className="at">@</span>
                <span className="tm2">{g.home.split(' ').pop()}</span>
                <span className="tme">{cleanTime(g.startTime, showDate)}</span>
              </div>
              {shown.map((p, i) => pickMode === 'build'
                ? renderBuildRow(p, i)
                : renderWatchRow(p, i))}
              {hidden.length > 0 && (
                <div className="more" onClick={() => setExpandedGames(prev => ({ ...prev, [gi]: true }))}>
                  + {hidden.length} market{hidden.length > 1 ? 's' : ''} · tier 5
                </div>
              )}
            </div>
          );
        })}
        {gameList.length === 0 && (
          <div className="empty">
            {pickMode === 'watch' ? 'No positions locked yet.' : allPicks.length === 0 ? 'No plays for this day.' : 'No picks match this filter.'}
          </div>
        )}
      </div>
    </div>
  );
}

// Find the actual opposite-side pick from data (real odds), fallback to flipPick
function findOppositePick(p, allPicks) {
  const bt = (p.betType || p.market || '').toLowerCase();
  const candidates = allPicks.filter(c =>
    c.league === p.league && c.away === p.away && c.home === p.home &&
    (c.betType || c.market || '').toLowerCase() === bt
  );
  if (bt === 'moneyline' || bt === 'spread') {
    const opp = candidates.find(c => (c.pick || '').toLowerCase() !== (p.pick || '').toLowerCase());
    if (opp) return opp;
  }
  if (bt === 'total') {
    const isOver = (p.pick || '').toLowerCase().includes('over');
    const opp = candidates.find(c => {
      const cIsOver = (c.pick || '').toLowerCase().includes('over');
      return cIsOver !== isOver;
    });
    if (opp) return opp;
  }
  return flipPick(p); // fallback to approximation
}

// ── 3-way (soccer) side selection ───────────────────────────────────
// A soccer moneyline has THREE outcomes, but the model logs only one pick per
// match (its best-edge side). Before 2026-08-28 putting yourself on a different
// side ran through flipPick() below — a two-way helper that swaps home/away and
// inverts the odds sign. That can't express a draw at all, and the inverted
// price is fiction in a 3-outcome market. Now the ledger row carries
// `altPrices` ({home,draw,away} American odds, all de-vigged the same way the
// pick's own `odds` is), and these helpers read the real number.
const SIDES = ['home', 'draw', 'away'];

function isThreeWay(p) {
  return isSoccer(p.league) && (p.betType || p.market || '').toLowerCase() === 'moneyline';
}

// Which side the MODEL took. Prefer the explicit `selection` column; fall back to
// matching the pick text against the team names for rows written before it existed.
function modelSide(p) {
  if (p.selection && SIDES.includes(p.selection)) return p.selection;
  const t = (p.pick || '').toLowerCase().trim();
  if (t === 'draw') return 'draw';
  const home = (p.home || '').toLowerCase();
  if (t && home && (t.includes(home) || home.includes(t))) return 'home';
  return 'away';
}

// A rendered pick is the draw when its text says so — true for the model's own
// draw pick and for one you switched to, on new rows and legacy rows alike.
const isDrawPick = (d) => (d.pick || '').toLowerCase().trim() === 'draw';

function sideLabel(p, side) {
  return side === 'draw' ? 'Draw' : side === 'home' ? p.home : p.away;
}

// The price for one side. The model's own side is quoted from `odds` (authoritative,
// and present on every row ever written); the other two come from altPrices. Returns
// null when we genuinely don't have it — callers must disable the side, not guess.
function sidePrice(p, side) {
  if (side === modelSide(p)) return p.odds ?? null;
  const v = p.altPrices && p.altPrices[side];
  return Number.isFinite(v) ? v : null;
}

function sideAvailable(p, side) {
  return sidePrice(p, side) != null;
}

// Build the pick object as if the model had taken `side` — real name, real price.
function pickForSide(p, side) {
  if (side === modelSide(p)) return p;
  return { ...p, pick: sideLabel(p, side), odds: sidePrice(p, side), selection: side };
}

// THE single place that answers "which pick object do I render for this row?".
// Every surface (Picks build/watch rows, Scores pips, expanded game, P/L maths)
// goes through this, so a position can never display as one side here and another
// side there. `allPicks` is optional: it's only used by the two-way path, to find
// a real opposite-side row before falling back to flipPick's approximation.
function displayPickFor(p, entry, allPicks) {
  if (isThreeWay(p)) {
    const side = entrySide(entry) || modelSide(p);
    return sideAvailable(p, side) ? pickForSide(p, side) : p;
  }
  if (entryState(entry) !== 'fade') return p;
  return allPicks ? findOppositePick(p, allPicks) : flipPick(p);
}

// ── Scores Tab ──────────────────────────────────────────────────────
// Flip a pick to the opposite side (for fades). TWO-WAY MARKETS ONLY — soccer
// moneylines must go through pickForSide() above, which has real prices.
function flipPick(p) {
  const bt = (p.betType || p.market || '').toLowerCase();
  if (bt === 'moneyline') {
    // Swap to the other team, invert odds sign as approximation
    const isHome = (p.pick || '').toLowerCase().includes((p.home || '').split(' ').pop().toLowerCase());
    const flippedOdds = p.odds > 0 ? -(p.odds) : Math.abs(p.odds);
    return { ...p, pick: isHome ? p.away : p.home, odds: flippedOdds };
  }
  if (bt === 'spread') {
    // Swap team + negate line (odds stay ~same for spreads, typically -110 both sides)
    const isHome = (p.pick || '').toLowerCase().includes((p.home || '').split(' ').pop().toLowerCase());
    const newLine = parseFloat(p.line) ? String(-parseFloat(p.line)) : p.line;
    return { ...p, pick: isHome ? p.away : p.home, line: newLine };
  }
  if (bt === 'total') {
    const isOver = (p.pick || '').toLowerCase().includes('over');
    return { ...p, pick: isOver ? `Under ${p.line}` : `Over ${p.line}` };
  }
  return p;
}

// A pick's `pick` field is "Team Name" for moneyline but "Team Name +3.5" for
// spread (the line is duplicated as its own field and also baked into the
// display string) — strip that suffix so team-logo lookups match TEAM_CODES.
// Safe no-op for moneyline/total, where there's no line substring to strip.
function teamOnly(p) {
  if (!p.line) return p.pick || '';
  return (p.pick || '').replace(p.line, '').trim();
}

// ── Scores Tab (Direction A — Tape) ───────────────────────────────────
// One game open in the tape at a time; every other game is a condensed row
// carrying a fixed ML/Spread/Total pip cluster (team mark or O/U per held
// slot, faint dot when empty).
function ScoresTab({ liveGames, picks, isBet, isFade, displayPick, lastUpdated, stake }) {
  const hasAnyPosition = picks.some(p => isBet(p) || isFade(p));
  const [sf, setSf] = useState(() => (hasAnyPosition ? 'My Bets' : 'All'));
  const [sortAlt, setSortAlt] = useState(false);
  const [expandedKey, setExpandedKey] = useState(null);

  const matchupGames = buildMatchupGames(liveGames);
  const pickBelongs = (p, game) => pickBelongsToGame(matchupGames, p, game);

  const leagueCounts = {};
  for (const g of liveGames) leagueCounts[g.league] = (leagueCounts[g.league] || 0) + 1;
  const leagues = Object.keys(leagueCounts).sort((a, b) => leagueCounts[b] - leagueCounts[a]);
  const liveCount = liveGames.filter(g => g.status === 'in').length;
  const mineCount = liveGames.filter(g => picks.some(p => p.league === g.league && p.away === g.away && p.home === g.home && pickBelongs(p, g) && (isBet(p) || isFade(p)))).length;

  const sportFiltered = liveGames.filter(g => {
    if (sf === 'My Bets') return picks.some(p => p.league === g.league && p.away === g.away && p.home === g.home && pickBelongs(p, g) && (isBet(p) || isFade(p)));
    if (sf === 'Live') return g.status === 'in';
    if (sf === 'All') return true;
    return g.league === sf;
  });
  const sorted = sortAlt ? [...sportFiltered].sort((a, b) => (a.gameDate || '').localeCompare(b.gameDate || '')) : sortGames(sportFiltered);

  const gameData = sorted.map(game => {
    // gamePicks: every market the model has for this game (ExpandedGame's full
    // context view). myPicks: just the ones actually taken/faded — the condensed
    // row's pips, stake total, and live P/L must only ever reflect these, never
    // the whole slate, or a game you have one market on reads as if you had all.
    const gamePicks = picks.filter(p => p.league === game.league && p.away === game.away && p.home === game.home && pickBelongs(p, game));
    const myPicks = gamePicks.filter(p => isBet(p) || isFade(p));
    const displayPicks = myPicks.map(p => displayPick(p, picks));
    const isPre = game.status === 'pre';
    const isLive = game.status === 'in';
    const isPost = game.status === 'post' || game.status === 'postponed';
    const key = `${game.league}|${game.away}@${game.home}|${game.gameDate || ''}`;
    let dayPL = 0;
    for (let i = 0; i < myPicks.length; i++) {
      if (isPre) continue;
      const status = getEffectiveStatus(displayPicks[i], game);
      dayPL += status === 'winning' ? calcProfit(displayPicks[i].odds, stake(myPicks[i])) : status === 'losing' ? -stake(myPicks[i]) : 0;
    }
    return { game, gamePicks, myPicks, displayPicks, isPre, isLive, isPost, key, dayPL };
  });

  // Slate strip: final W-L and live W-L(-push) across ALL of today's positions,
  // independent of the active filter.
  const tally = { final: { w: 0, l: 0 }, live: { w: 0, l: 0, t: 0 } };
  let dayPLTotal = 0;
  for (const g of liveGames) {
    if (g.status === 'pre') continue;
    const gPicks = picks.filter(p => p.league === g.league && p.away === g.away && p.home === g.home && pickBelongs(p, g) && (isBet(p) || isFade(p)));
    for (const p of gPicks) {
      const disp = displayPick(p, picks);
      const status = getEffectiveStatus(disp, g);
      const bucket = g.status === 'in' ? tally.live : tally.final;
      if (status === 'winning') { bucket.w++; dayPLTotal += calcProfit(disp.odds, stake(p)); }
      else if (status === 'losing') { bucket.l++; dayPLTotal -= stake(p); }
      else if (g.status === 'in') { tally.live.t++; }
    }
  }

  const openKey = (expandedKey && gameData.some(d => d.key === expandedKey)) ? expandedKey : null;
  const abbr = (name) => (name || '').split(' ').pop();

  const teamChip = (name, league, mini) => {
    const url = teamLogo(name, league);
    return (
      <span className={mini ? 'tmini' : 'tm'}>
        {url ? <img src={url} alt="" /> : <span style={{ fontSize: mini ? 6 : 8, fontWeight: 700, color: 'var(--dim)' }}>{(name || '').slice(0, 3).toUpperCase()}</span>}
      </span>
    );
  };
  // Fixed ML / Spread / Total slots, always in that order, so the same
  // market always lands in the same slot. A held slot shows the side you
  // need — team mark for ML/Spread, O/U for Total — reading a fade as its
  // flipped (effective) side with a thin orange underline, so the row reads
  // "who am I on" without having to remember which picks were fades. An
  // empty slot stays a faint dot.
  const PIP_MARKETS = ['moneyline', 'spread', 'total'];
  const positionPips = (myPicks) => (
    <span className="pips">
      {PIP_MARKETS.map(mkt => {
        const p = myPicks.find(pk => (pk.betType || pk.market || '').toLowerCase() === mkt);
        if (!p) return <span key={mkt} className="pslot"><i className="off"></i></span>;
        const faded = isFade(p);
        const display = displayPick(p, picks);
        const isTotal = mkt === 'total';
        const url = isTotal || isDrawPick(display) ? null : teamLogo(teamOnly(display), display.league);
        // The draw has no crest — give it the "level" glyph instead of letting the
        // 3-letter fallback below render "DRA".
        const glyph = isTotal ? ((display.pick || '').toLowerCase().includes('over') ? '▲' : '▼') : isDrawPick(display) ? '=' : null;
        return (
          <span key={mkt} className={`pslot pchip${faded ? ' fd' : ''}`}>
            {url ? <img src={url} alt="" /> : <b>{glyph || (teamOnly(display) || '').slice(0, 3).toUpperCase()}</b>}
          </span>
        );
      })}
    </span>
  );

  const isEmpty = gameData.length === 0;

  return (
    <div className="tp">
      <div className="ah">
        <b>Scores</b>
        <span>{liveCount} LIVE · UPDATED {lastUpdated ? lastUpdated.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).toUpperCase() : '—'}</span>
      </div>
      <div className="astrip">
        <div><span className="k">Final</span><span className="v">{tally.final.w}–{tally.final.l}</span></div>
        <div><span className="k">Live</span><span className="v">{tally.live.w}–{tally.live.l}{tally.live.t ? <s>–{tally.live.t}</s> : null}</span></div>
        <div><span className="k">Day P/L</span><span className={`v ${dayPLTotal >= 0 ? 'up' : 'dn'}`}>{dayPLTotal >= 0 ? '+' : ''}{dayPLTotal.toFixed(2)}<s>u</s></span></div>
      </div>
      <div className="aleagues scroll">
        <button className={sf === 'All' ? 'sel' : ''} onClick={() => setSf('All')}><span className="lg">ALL</span><span className="ct">{liveGames.length}</span></button>
        <button className={sf === 'My Bets' ? 'sel' : ''} disabled={mineCount === 0} onClick={() => setSf('My Bets')}><span className="lg">MINE</span><span className="ct">{mineCount}</span></button>
        <button className={sf === 'Live' ? 'sel' : ''} onClick={() => setSf('Live')}><span className="lg">LIVE</span><span className="ct">{liveCount}</span></button>
        {leagues.map(l => (
          <button key={l} className={sf === l ? 'sel' : ''} onClick={() => setSf(l)}><span className="lg">{l}</span><span className="ct">{leagueCounts[l]}</span></button>
        ))}
        <button onClick={() => setSortAlt(v => !v)}><span className="glyph">⇅</span></button>
      </div>

      {isEmpty && <div className="empty">{sf === 'Live' ? 'No live games right now.' : sf === 'My Bets' ? 'No positions on today’s games yet.' : 'No games today.'}</div>}

      {gameData.length > 0 && <div className="consec"><span>Today · {gameData.length} game{gameData.length > 1 ? 's' : ''}</span></div>}
      {gameData.map(d => d.key === openKey
        ? <ExpandedGame key={d.key} d={d} isBet={isBet} isFade={isFade} displayPick={displayPick} allPicks={picks} teamChip={teamChip} stake={stake} onClose={() => setExpandedKey(null)} />
        : (() => {
          const { game, myPicks, isPre, key } = d;
          return (
            <div key={key} className={`acon${d.isLive ? ' live' : ''}`} onClick={() => setExpandedKey(key)}>
              <span className="lg">{game.league}</span>
              <span className="duo">{teamChip(game.away, game.league, true)}{teamChip(game.home, game.league, true)}</span>
              <span className="mt">{abbr(game.away)} <s>at</s> {abbr(game.home)}</span>
              <span className="sc">{isPre ? cleanTime(game.period) : `${game.awayScore}–${game.homeScore}`}</span>
              {positionPips(myPicks)}
              {myPicks.length > 0
                ? <span className={`pos apnl ${isPre ? 'fl' : d.dayPL > 0 ? 'up' : d.dayPL < 0 ? 'dn' : 'fl'}`}>{isPre ? myPicks.reduce((s, p) => s + stake(p), 0).toFixed(2) : `${d.dayPL >= 0 ? '+' : ''}${d.dayPL.toFixed(2)}`}<em>u</em></span>
                : <span className="pos" style={{ color: 'var(--dim2)' }}>—</span>}
            </div>
          );
        })())}
    </div>
  );
}

function ExpandedGame({ d, isBet, isFade, displayPick, allPicks, teamChip, stake, onClose }) {
  const { game, gamePicks, isPre } = d;
  const aw = game.awayLinescores || [];
  const ho = game.homeLinescores || [];
  const periods = Math.max(aw.length, ho.length);
  return (
    <div className="agame">
      <div className="agh" onClick={onClose} style={{ cursor: 'pointer' }}>
        <span className="lgm">{game.league}</span>
        <span className="duo">{teamChip(game.away, game.league, true)}{teamChip(game.home, game.league, true)}</span>
        <span className="tm2">{game.away.split(' ').pop()}</span>
        {!isPre && <span className="sc">{game.awayScore}</span>}
        <span className="at">{isPre ? '@' : '–'}</span>
        {!isPre && <span className="sc">{game.homeScore}</span>}
        <span className="tm2">{game.home.split(' ').pop()}</span>
        <span className="close">▴ close</span>
      </div>
      {gamePicks.map((p, j) => {
        const faded = isFade(p);
        const display = displayPick(p, allPicks);
        const bt = (display.betType || display.market || '').toLowerCase();
        const code = bt === 'moneyline' ? 'ML' : bt === 'spread' ? 'SPR' : 'TOT';
        const isTotal = bt === 'total';
        const isOver = isTotal && (display.pick || '').toLowerCase().includes('over');
        const status = isPre ? 'pending' : getEffectiveStatus(display, game);
        const pl = status === 'winning' ? calcProfit(display.odds, stake(p)) : status === 'losing' ? -stake(p) : 0;
        return (
          <div key={j} className={`sr${j === 0 ? ' first' : ''}${!faded && isBet(p) ? ' take' : ''}${faded ? ' fade' : ''}`}>
            <b className={`tick ${tierHeightClass(tierOf(p))}`}></b>
            <div className="rm">
              <span className="mkt">{code}</span>
              {isTotal ? <span className="tm ou">{isOver ? '▲' : '▼'}</span> : isDrawPick(display) ? <span className="tm ou">=</span> : teamChip(display.pick, p.league)}
              <span className="side">{display.pick}{display.line ? ` ${display.line}` : ''}{faded && <i> · fade</i>}</span>
            </div>
            <span className="p num">{fmt(display.odds)}</span>
            <span className="un num">{stake(p).toFixed(2)}<em style={{ fontStyle: 'normal', fontSize: 9, color: 'var(--dim2)' }}>u</em></span>
            <span className={`apnl num ${isPre ? 'fl' : status === 'winning' ? 'up' : status === 'losing' ? 'dn' : 'fl'}`}>{isPre ? '0.00' : `${pl >= 0 ? '+' : ''}${pl.toFixed(2)}`}</span>
          </div>
        );
      })}
      {periods > 0 && (
        <div className="ls" style={{ gridTemplateColumns: `1fr repeat(${periods}, 25px) 25px` }}>
          <span className="tn"></span>
          {Array.from({ length: periods }).map((_, pi) => <span key={pi} className="hd">{game.league === 'MLB' ? pi + 1 : `${game.league === 'NHL' ? 'P' : 'Q'}${pi + 1}`}</span>)}
          <span className="hd">T</span>
          <span className="tn">{game.away.split(' ').pop()}</span>
          {Array.from({ length: periods }).map((_, pi) => <span key={pi} className="n">{aw[pi] !== undefined ? aw[pi] : '·'}</span>)}
          <span className="n t">{game.awayScore}</span>
          <span className="tn">{game.home.split(' ').pop()}</span>
          {Array.from({ length: periods }).map((_, pi) => <span key={pi} className="n">{ho[pi] !== undefined ? ho[pi] : '·'}</span>)}
          <span className="n t">{game.homeScore}</span>
        </div>
      )}
      {game.situation?.lastPlay && (
        <div className="adet">
          <span className="p1">{game.situation.lastPlay}</span>
          <span className="p2">
            {game.league === 'MLB' && game.situation.outs != null && `${game.situation.outs} OUT`}
            {game.league === 'MLB' && game.situation.batter && ` · AB ${game.situation.batter}`}
            {game.league === 'MLB' && game.situation.pitcher && ` · P ${game.situation.pitcher}`}
            {game.league === 'NFL' && game.situation.downDistance}
          </span>
        </div>
      )}
      {(game.awayRecord || game.homeRecord || game.venue || game.broadcast) && (
        <div className="ameta">
          {game.awayRecord && <span>{game.away.split(' ').pop().toUpperCase()} {game.awayRecord}</span>}
          {game.homeRecord && <span>{game.home.split(' ').pop().toUpperCase()} {game.homeRecord}</span>}
          {game.venue && <span>{game.venue.toUpperCase()}</span>}
          {game.broadcast && <span>{game.broadcast.toUpperCase()}</span>}
        </div>
      )}
    </div>
  );
}

// ── Props Tab ───────────────────────────────────────────────────────
function PropsTab({ props, todayGames, sf, pf, propDateFilter, isPropBet, isPropFade, toggleProp, liveStats, myPropBets }) {
  // Helper: format timestamp as relative time ago
  const timeAgo = (ts) => {
    if (!ts) return null;
    const diff = Math.max(0, Date.now() - ts);
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  };

  // Build game-to-date lookup from todayGames commence times
  const gameCommence = {};
  for (const g of (todayGames || [])) {
    const key = `${g.away} @ ${g.home}`;
    if (g.commence) gameCommence[key] = g.commence;
    // Also store with reversed order for flexibility
    const revKey = `${g.home} vs ${g.away}`;
    if (g.commence) gameCommence[revKey] = g.commence;
  }

  // Helper: get date string (YYYY-MM-DD in local time) from a prop's game
  const getPropDate = (p) => {
    const commence = gameCommence[p.game];
    if (!commence) return null;
    try {
      return new Date(commence).toLocaleDateString('en-CA'); // YYYY-MM-DD
    } catch { return null; }
  };

  const todayStr = new Date().toLocaleDateString('en-CA');
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toLocaleDateString('en-CA');

  // "My Bets" view: show stored prop selections with locked-in lines
  if (sf === 'My Bets') {
    const myProps = (myPropBets || []).map(stored => {
      // Find matching current prop to get live stats context
      const currentProp = props.find(p =>
        p.player === stored.player && p.market === stored.market &&
        p.direction === stored.direction && p.book === stored.book
      );
      // Use stored line/odds but current prop's other data for live tracking
      return {
        ...(currentProp || {}),
        player: stored.player,
        league: stored.league,
        market: stored.market,
        direction: stored.direction,
        book: stored.book,
        game: stored.game || (currentProp ? currentProp.game : ''),
        line: stored.line, // locked-in line
        bookOdds: stored.odds, // locked-in odds
        selectedAt: stored.selectedAt || null,
        _isMyBet: true,
        _state: stored.state,
        // Keep current prop's consensus/edge if available
        consensusProb: currentProp ? currentProp.consensusProb : '',
        bookProb: currentProp ? currentProp.bookProb : '',
        edge: currentProp ? currentProp.edge : '',
      };
    });

    // Filter by sportsbook
    let myFiltered = myProps;
    if (pf !== 'All') myFiltered = myFiltered.filter(p => p.book === pf);

    if (!myFiltered.length) return <div style={{ textAlign: 'center', color: '#64748B', padding: 40, fontSize: 14 }}>No prop bets selected yet</div>;

    const isOver = (d) => (d || '').toLowerCase() === 'over';

    return (
      <>
        <div style={{ background: 'rgba(75,156,211,0.08)', borderRadius: 12, padding: '10px 14px', marginBottom: 10, border: '1px solid rgba(75,156,211,0.2)', boxShadow: '0 2px 8px rgba(0,0,0,0.3)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#BAE0F5' }}>My Prop Bets</div>
          <div style={{ fontSize: 11, color: '#64748B' }}>{myFiltered.length} selections</div>
        </div>
        {myFiltered.map((p, i) => {
          const edgeNum = parseFloat(p.edge) || 0;
          const edgeColor = edgeNum >= 8 ? '#34D399' : edgeNum >= 5 ? '#FBBF24' : '#64748B';
          const dirColor = isOver(p.direction) ? '#34D399' : '#F87171';
          const faded = p._state === 'fade';
          const live = liveStats[`prop|${p.league}|${p.player}|${p.market}|${p.direction}|${p.book}`] || null;
          const lineNum = parseFloat(p.line) || 0;
          const isOverBet = isOver(p.direction);

          let statStatus = null, statColor = '#64748B', statLabel = '';
          if (live) {
            const cur = live.current;
            const isGameOver = live.gameStatus === 'post';
            const diff = lineNum - cur;
            if (isOverBet) {
              if (cur >= lineNum) { statStatus = 'hit'; statColor = '#34D399'; statLabel = isGameOver ? 'HIT ✅' : 'OVER ✅'; }
              else if (isGameOver) { statStatus = 'miss'; statColor = '#F87171'; statLabel = 'MISSED ❌'; }
              else if (diff <= 3) { statStatus = 'close'; statColor = '#FCD34D'; statLabel = `NEEDS ${diff % 1 === 0 ? diff : diff.toFixed(1)} MORE`; }
              else { statStatus = 'behind'; statColor = '#94A3B8'; statLabel = `NEEDS ${diff % 1 === 0 ? diff : diff.toFixed(1)} MORE`; }
            } else {
              if (isGameOver && cur <= lineNum) { statStatus = 'hit'; statColor = '#34D399'; statLabel = 'HIT ✅'; }
              else if (cur > lineNum) { statStatus = 'miss'; statColor = '#F87171'; statLabel = isGameOver ? 'MISSED ❌' : 'OVER LINE ⚠️'; }
              else if (diff <= 2) { statStatus = 'close'; statColor = '#FCD34D'; statLabel = 'CLOSE'; }
              else { statStatus = 'safe'; statColor = '#34D399'; statLabel = 'ON PACE'; }
            }
          }

          const isLiveGame = live && live.gameStatus === 'in';
          const isDoneGame = live && live.gameStatus === 'post';

          return (
            <div key={i} onClick={() => toggleProp(p)} style={{
              background: faded ? 'rgba(255,199,44,0.12)' : 'rgba(75,156,211,0.12)',
              borderRadius: 12, marginBottom: 6, padding: '10px 12px',
              border: faded ? '2px solid rgba(255,199,44,0.4)' : '2px solid rgba(75,156,211,0.4)',
              boxShadow: isLiveGame ? '0 2px 16px rgba(75,156,211,0.25)' : '0 1px 6px rgba(0,0,0,0.2)',
              borderLeft: faded ? '5px solid #FFC72C' : (live ? `5px solid ${statColor}` : '5px solid #4B9CD3'),
              opacity: isDoneGame ? 0.7 : 1,
              cursor: 'pointer', transition: 'background 0.15s, opacity 0.3s',
            }}>
              {live && statStatus === 'close' && <div style={{ background: 'rgba(252,211,77,0.15)', color: '#FCD34D', fontSize: 10, fontWeight: 700, padding: '3px 10px', marginBottom: 6, marginLeft: -12, marginRight: -12, marginTop: -10, textAlign: 'center', borderRadius: '12px 12px 0 0' }}>🔥 CLOSE — {isOverBet ? `${(lineNum - live.current) % 1 === 0 ? (lineNum - live.current) : (lineNum - live.current).toFixed(1)} away` : 'approaching line'}</div>}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 3 }}>
                    {faded ? <span style={{ fontSize: 9, fontWeight: 700, color: '#FFE08A', background: 'rgba(255,199,44,0.25)', padding: '1px 5px', borderRadius: 3 }}>FADE</span>
                      : <span style={{ fontSize: 9, fontWeight: 700, color: '#BAE0F5', background: 'rgba(75,156,211,0.25)', padding: '1px 5px', borderRadius: 3 }}>MY BET</span>}
                    {live && <span style={{ width: isLiveGame ? 8 : 6, height: isLiveGame ? 8 : 6, borderRadius: '50%', background: isLiveGame ? '#34D399' : '#64748B', display: 'inline-block', boxShadow: isLiveGame ? '0 0 6px rgba(52,211,153,0.6)' : 'none', animation: isLiveGame ? 'pulse 2s infinite' : 'none' }} />}
                    {p.league && <span style={{ background: LEAGUE_COLORS[p.league] || '#6B7280', color: LEAGUE_TEXT[p.league] || 'white', fontSize: 9, fontWeight: 700, padding: '2px 5px', borderRadius: 3 }}>{p.league}</span>}
                  </div>
                  <div style={{ fontSize: 15, fontWeight: 800, color: '#F1F5F9', marginBottom: 1 }}>{p.player}</div>
                  <div style={{ fontSize: 12, fontWeight: 700, color: '#94A3B8', marginBottom: 4, textTransform: 'capitalize' }}>{(p.market || '').replace(/_/g, ' ')}</div>
                  <div style={{
                    display: 'inline-flex', alignItems: 'center', gap: 6, marginBottom: 4,
                    background: isOver(p.direction) ? 'rgba(16,185,129,0.12)' : 'rgba(248,113,113,0.12)',
                    border: `1px solid ${isOver(p.direction) ? 'rgba(16,185,129,0.25)' : 'rgba(248,113,113,0.25)'}`,
                    padding: '3px 10px', borderRadius: 6,
                  }}>
                    <span style={{ fontSize: 13, fontWeight: 800, color: dirColor, textTransform: 'uppercase' }}>{p.direction}</span>
                    <span style={{ fontSize: 15, fontWeight: 900, color: '#F1F5F9' }}>{p.line}</span>
                    <span style={{ fontSize: 11, color: '#94A3B8' }}>{fmt(p.bookOdds)}</span>
                  </div>
                  <div style={{ fontSize: 10, color: '#64748B', marginTop: 1 }}>
                    <span>via {p.book}</span>
                    {p.edge && <span> · <span style={{ color: edgeColor, fontWeight: 700 }}>{p.edge}% edge</span></span>}
                    {p.selectedAt && <span> · <span style={{ color: (Date.now() - p.selectedAt) > 3600000 ? '#FBBF24' : '#64748B' }}>{timeAgo(p.selectedAt)}</span></span>}
                  </div>
                </div>
                {live ? (
                  <div style={{ textAlign: 'center', marginLeft: 12, flexShrink: 0, minWidth: 55 }}>
                    <div style={{ fontSize: 26, fontWeight: 900, color: statColor, lineHeight: 1 }}>{live.current}</div>
                    <div style={{ fontSize: 11, color: '#94A3B8', marginTop: 2 }}>/ {p.line}</div>
                    <div style={{ width: 46, height: 3, background: 'rgba(255,255,255,0.1)', borderRadius: 2, margin: '3px auto', overflow: 'hidden' }}>
                      <div style={{ height: '100%', width: `${Math.min(100, (live.current / (lineNum || 1)) * 100)}%`, background: statColor, borderRadius: 2, transition: 'width 0.3s' }} />
                    </div>
                    <div style={{ fontSize: 8, fontWeight: 700, color: statColor, marginTop: 1 }}>{statLabel}</div>
                  </div>
                ) : (
                  <div style={{ textAlign: 'center', marginLeft: 12, flexShrink: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 700, color: '#94A3B8' }}>{fmt(p.bookOdds)}</div>
                    <div style={{ fontSize: 9, color: '#64748B' }}>locked</div>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </>
    );
  }

  // Filter by date
  let filtered = props.filter(p => {
    if (propDateFilter === 'All') return true;
    const d = getPropDate(p);
    if (!d) return propDateFilter === 'Today'; // No date = assume today
    if (propDateFilter === 'Today') return d === todayStr;
    if (propDateFilter === 'Tomorrow') return d === tomorrowStr;
    return true;
  });

  // Filter by sport
  filtered = filtered.filter(p => {
    if (sf !== 'All' && sf !== 'Live' && p.league !== sf) return false;
    return true;
  });

  // Filter by sportsbook
  if (pf !== 'All') {
    filtered = filtered.filter(p => p.book === pf);
  }

  // Sort by edge descending (already sorted from backend, but enforce here)
  filtered.sort((a, b) => b.edge - a.edge);

  if (!filtered.length) return <div style={{ textAlign: 'center', color: '#64748B', padding: 40, fontSize: 14 }}>No prop edges found</div>;

  const isOver = (d) => (d || '').toLowerCase() === 'over';

  return (
    <>
      <div style={{ background: 'rgba(255,255,255,0.04)', borderRadius: 12, padding: '10px 14px', marginBottom: 10, border: '1px solid rgba(255,255,255,0.08)', boxShadow: '0 2px 8px rgba(0,0,0,0.3)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: '#F1F5F9' }}>Top Edges</div>
        <div style={{ fontSize: 11, color: '#64748B' }}>{filtered.length} props found</div>
      </div>
      {filtered.map((p, i) => {
        const edgeNum = parseFloat(p.edge) || 0;
        const edgeColor = edgeNum >= 8 ? '#34D399' : edgeNum >= 5 ? '#FBBF24' : '#64748B';
        const edgeBg = edgeNum >= 8 ? 'rgba(16,185,129,0.15)' : edgeNum >= 5 ? 'rgba(251,191,36,0.15)' : 'rgba(255,255,255,0.08)';
        const dirColor = isOver(p.direction) ? '#34D399' : '#F87171';
        const selected = isPropBet(p);
        const faded = isPropFade(p);
        const live = liveStats[`prop|${p.league}|${p.player}|${p.market}|${p.direction}|${p.line}|${p.book}`] || null;
        const lineNum = parseFloat(p.line) || 0;
        const isOverBet = isOver(p.direction);

        // Live stat status
        let statStatus = null, statColor = '#64748B', statLabel = '';
        if (live) {
          const cur = live.current;
          const isGameOver = live.gameStatus === 'post';
          const diff = lineNum - cur;

          if (isOverBet) {
            if (cur >= lineNum) { statStatus = 'hit'; statColor = '#34D399'; statLabel = isGameOver ? 'HIT ✅' : 'OVER ✅'; }
            else if (isGameOver) { statStatus = 'miss'; statColor = '#F87171'; statLabel = 'MISSED ❌'; }
            else if (diff <= 3) { statStatus = 'close'; statColor = '#FCD34D'; statLabel = `NEEDS ${diff % 1 === 0 ? diff : diff.toFixed(1)} MORE`; }
            else { statStatus = 'behind'; statColor = '#94A3B8'; statLabel = `NEEDS ${diff % 1 === 0 ? diff : diff.toFixed(1)} MORE`; }
          } else {
            if (isGameOver && cur <= lineNum) { statStatus = 'hit'; statColor = '#34D399'; statLabel = 'HIT ✅'; }
            else if (cur > lineNum) { statStatus = 'miss'; statColor = '#F87171'; statLabel = isGameOver ? 'MISSED ❌' : 'OVER LINE ⚠️'; }
            else if (diff <= 2) { statStatus = 'close'; statColor = '#FCD34D'; statLabel = 'CLOSE'; }
            else { statStatus = 'safe'; statColor = '#34D399'; statLabel = 'ON PACE'; }
          }
        }

        const isLiveGame = live && live.gameStatus === 'in';
        const isDoneGame = live && live.gameStatus === 'post';

        return (
          <div key={i} onClick={() => toggleProp(p)} style={{
            background: faded ? 'rgba(255,199,44,0.12)' : selected ? (live && statStatus === 'close' ? 'rgba(252,211,77,0.08)' : 'rgba(75,156,211,0.12)') : 'rgba(255,255,255,0.04)',
            borderRadius: 12, marginBottom: 6, padding: '10px 12px',
            border: isDoneGame && !selected ? '1px solid rgba(255,255,255,0.06)' : faded ? '2px solid rgba(255,199,44,0.4)' : selected ? (live && statStatus === 'close' ? '2px solid rgba(252,211,77,0.3)' : '2px solid rgba(75,156,211,0.4)') : '1px solid rgba(255,255,255,0.08)',
            boxShadow: isLiveGame ? (faded ? '0 2px 16px rgba(255,199,44,0.25)' : selected ? '0 2px 16px rgba(75,156,211,0.25)' : '0 2px 12px rgba(0,0,0,0.4)') : '0 1px 6px rgba(0,0,0,0.2)',
            borderLeft: faded ? '5px solid #FFC72C' : selected ? (live ? `5px solid ${statColor}` : '5px solid #4B9CD3') : isDoneGame ? `4px solid ${statColor}` : `3px solid ${edgeColor}`,
            opacity: isDoneGame && !selected ? 0.65 : 1,
            cursor: 'pointer', transition: 'background 0.15s, border-left 0.15s, opacity 0.3s',
          }}>
            {live && statStatus === 'close' && <div style={{ background: 'rgba(252,211,77,0.15)', color: '#FCD34D', fontSize: 10, fontWeight: 700, padding: '3px 10px', marginBottom: 6, marginLeft: -12, marginRight: -12, marginTop: -10, textAlign: 'center', borderRadius: '12px 12px 0 0' }}>🔥 CLOSE — {isOverBet ? `${(lineNum - live.current) % 1 === 0 ? (lineNum - live.current) : (lineNum - live.current).toFixed(1)} away` : 'approaching line'}</div>}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 3 }}>
                  {faded && <span style={{ fontSize: 9, fontWeight: 700, color: '#FFE08A', background: 'rgba(255,199,44,0.25)', padding: '1px 5px', borderRadius: 3 }}>FADE</span>}
                  {selected && !faded && <span style={{ fontSize: 9, fontWeight: 700, color: '#BAE0F5', background: 'rgba(75,156,211,0.25)', padding: '1px 5px', borderRadius: 3 }}>MY BET</span>}
                  {live && <span style={{ width: isLiveGame ? 8 : 6, height: isLiveGame ? 8 : 6, borderRadius: '50%', background: isLiveGame ? '#34D399' : '#64748B', display: 'inline-block', boxShadow: isLiveGame ? '0 0 6px rgba(52,211,153,0.6)' : 'none', animation: isLiveGame ? 'pulse 2s infinite' : 'none' }} />}
                  {p.league && <span style={{ background: LEAGUE_COLORS[p.league] || '#6B7280', color: LEAGUE_TEXT[p.league] || 'white', fontSize: 9, fontWeight: 700, padding: '2px 5px', borderRadius: 3 }}>{p.league}</span>}
                  <span style={{ fontSize: 10, fontWeight: 600, color: '#64748B', background: 'rgba(255,255,255,0.08)', padding: '1px 5px', borderRadius: 3 }}>{p.market}</span>
                </div>
                <div style={{ fontSize: 15, fontWeight: 800, color: '#F1F5F9', marginBottom: 1 }}>{p.player}</div>
                <div style={{ fontSize: 12, fontWeight: 700, color: '#94A3B8', marginBottom: 4, textTransform: 'capitalize', letterSpacing: 0.3 }}>{(p.market || '').replace(/_/g, ' ')}</div>
                <div style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6, marginBottom: 4,
                  background: isOver(p.direction) ? 'rgba(16,185,129,0.12)' : 'rgba(248,113,113,0.12)',
                  border: `1px solid ${isOver(p.direction) ? 'rgba(16,185,129,0.25)' : 'rgba(248,113,113,0.25)'}`,
                  padding: '3px 10px', borderRadius: 6,
                }}>
                  <span style={{ fontSize: 13, fontWeight: 800, color: dirColor, textTransform: 'uppercase' }}>{p.direction}</span>
                  <span style={{ fontSize: 15, fontWeight: 900, color: '#F1F5F9' }}>{p.line}</span>
                  <span style={{ fontSize: 11, color: '#94A3B8' }}>{fmt(p.bookOdds)}</span>
                </div>
                <div style={{ fontSize: 10, color: '#94A3B8' }}>{p.game}{(() => {
                  const c = gameCommence[p.game];
                  if (!c) return null;
                  try {
                    const d = new Date(c);
                    const dateStr = d.toLocaleDateString('en-CA');
                    const isToday = dateStr === todayStr;
                    const isTmrw = dateStr === tomorrowStr;
                    const timeStr = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
                    const label = isToday ? timeStr : isTmrw ? `Tomorrow ${timeStr}` : `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ${timeStr}`;
                    return <span style={{ color: '#64748B', marginLeft: 4 }}>· {label}</span>;
                  } catch { return null; }
                })()}</div>
                <div style={{ fontSize: 10, color: '#64748B', marginTop: 1, display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
                  <span>via {p.book}</span>
                  {live ? (
                    <span>· <span style={{ color: edgeColor, fontWeight: 700 }}>{p.edge}% edge</span> · consensus {p.consensusProb}% vs book {p.bookProb}%</span>
                  ) : (
                    <span>· consensus {p.consensusProb}% vs book {p.bookProb}%</span>
                  )}
                </div>
              </div>
              {live ? (
                <div style={{ textAlign: 'center', marginLeft: 12, flexShrink: 0, minWidth: 55 }}>
                  <div style={{ fontSize: 26, fontWeight: 900, color: statColor, lineHeight: 1 }}>{live.current}</div>
                  <div style={{ fontSize: 11, color: '#94A3B8', marginTop: 2 }}>/ {p.line}</div>
                  <div style={{ width: 46, height: 3, background: 'rgba(255,255,255,0.1)', borderRadius: 2, margin: '3px auto', overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: `${Math.min(100, (live.current / (lineNum || 1)) * 100)}%`, background: statColor, borderRadius: 2, transition: 'width 0.3s' }} />
                  </div>
                  <div style={{ fontSize: 8, fontWeight: 700, color: statColor, marginTop: 1 }}>{statLabel}</div>
                </div>
              ) : (
                <div style={{ textAlign: 'center', marginLeft: 12, flexShrink: 0 }}>
                  <div style={{ fontSize: 22, fontWeight: 900, color: edgeColor }}>{p.edge}%</div>
                  <div style={{ fontSize: 9, fontWeight: 700, color: edgeColor, background: edgeBg, padding: '2px 8px', borderRadius: 10 }}>EDGE</div>
                </div>
              )}
            </div>
          </div>
        );
      })}
    </>
  );
}

// ── Model Changelog ────────────────────────────────────────────────
const MODEL_CHANGELOG = [
  { date: '2026-05-28', version: 'v2.5', title: 'Quick-Lock + Expanded Scores', changes: ['Morning Quick-Lock bulk selection for 0.2u+ picks', 'Period-by-period scoring and game leaders in Scores', 'My Bets filter on all tabs with cross-tab persistence', 'Model changelog in Results'] },
  { date: '2026-05-27', version: 'v2.4', title: 'MLB Pitchers + Progress Bars', changes: ['Starting pitcher + ERA display on MLB pick cards', 'Game progress bars on Scores cards', 'Pick status dots (flashing W/L indicators)', 'Doubleheader detection + Game 1/Game 2 labels', 'Settings tab with GitHub token + system review trigger'] },
  { date: '2026-05-26', version: 'v2.3', title: 'Prop Timing + Line Lock', changes: ['Selection timestamp on prop bets with staleness warning', 'Locked-in lines persist across line movements', 'My Bets section in Props tab'] },
  { date: '2026-05-25', version: 'v2.2', title: 'Visual Polish Pass', changes: ['Live vs completed game visual distinction', 'Game/Props toggle on Results tab', 'Prop date filter (Today/Tomorrow/All)'] },
  { date: '2026-05-24', version: 'v2.1', title: 'Fades + Cumulative Chart', changes: ['Three-state pick toggle: none → bet → fade', 'Faded picks flip to opposite side on Scores', 'Cumulative units chart on Results'] },
  { date: '2026-03-15', version: 'v2.0', title: 'Node.js Migration', changes: ['Migrated from Google Apps Script to Node.js + GitHub Actions', 'New Next.js web dashboard deployed on Vercel', 'ESPN live scores integration with 30s refresh'] },
];

function ChangelogTab() {
  return (
    <div>
      <div style={{ background: 'rgba(255,255,255,0.04)', borderRadius: 12, padding: '10px 14px', marginBottom: 10, border: '1px solid rgba(255,255,255,0.08)', boxShadow: '0 2px 8px rgba(0,0,0,0.3)', display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 14 }}>🔧</span>
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#F1F5F9' }}>Model Changelog</div>
          <div style={{ fontSize: 10, color: '#64748B' }}>Track what changed and when to correlate with performance</div>
        </div>
      </div>
      {MODEL_CHANGELOG.map((entry, i) => (
        <div key={i} style={{ background: 'rgba(255,255,255,0.04)', borderRadius: 10, marginBottom: 6, padding: '10px 12px', border: '1px solid rgba(255,255,255,0.08)', borderLeft: i === 0 ? '3px solid #F59E0B' : '3px solid rgba(255,255,255,0.08)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 10, fontWeight: 800, color: '#F59E0B', background: 'rgba(245,158,11,0.15)', padding: '2px 6px', borderRadius: 4 }}>{entry.version}</span>
              <span style={{ fontSize: 12, fontWeight: 700, color: '#F1F5F9' }}>{entry.title}</span>
            </div>
            <span style={{ fontSize: 10, color: '#64748B', fontWeight: 600 }}>{entry.date}</span>
          </div>
          {entry.changes.map((c, ci) => (
            <div key={ci} style={{ fontSize: 11, color: '#94A3B8', paddingLeft: 8, marginTop: 2, display: 'flex', gap: 5 }}>
              <span style={{ color: '#475569' }}>·</span> {c}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

// ── Cumulative Units Chart ──────────────────────────────────────────
function UnitsChart({ results }) {
  // Build cumulative units by date (oldest first)
  const parseDate = (d) => {
    if (!d) return null;
    const parts = d.split('/');
    if (parts.length !== 3) return null;
    return new Date(parseInt(parts[2]), parseInt(parts[0]) - 1, parseInt(parts[1]));
  };

  const byDate = {};
  for (const r of results) {
    if (!byDate[r.date]) byDate[r.date] = 0;
    byDate[r.date] += (r.unitReturn || 0);
  }
  const sortedDates = Object.keys(byDate).sort((a, b) => {
    const da = parseDate(a), db = parseDate(b);
    return (da?.getTime() || 0) - (db?.getTime() || 0);
  });

  if (sortedDates.length < 2) return null;

  // Build cumulative data points
  let cum = 0;
  const points = sortedDates.map(d => { cum += byDate[d]; return { date: d, value: cum }; });

  const W = 340, H = 120, PAD_L = 35, PAD_R = 10, PAD_T = 10, PAD_B = 22;
  const chartW = W - PAD_L - PAD_R;
  const chartH = H - PAD_T - PAD_B;

  const vals = points.map(p => p.value);
  const maxV = Math.max(...vals, 0.1);
  const minV = Math.min(...vals, -0.1);
  const range = maxV - minV || 1;

  const x = (i) => PAD_L + (i / (points.length - 1)) * chartW;
  const y = (v) => PAD_T + (1 - (v - minV) / range) * chartH;

  // SVG path
  const pathD = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');

  // Gradient fill path (area under curve to zero line)
  const zeroY = y(0);
  const areaD = `${pathD} L${x(points.length - 1).toFixed(1)},${zeroY.toFixed(1)} L${x(0).toFixed(1)},${zeroY.toFixed(1)} Z`;

  const current = points[points.length - 1].value;
  const lineColor = current >= 0 ? '#34C77B' : '#E5484D';
  const fillColor = current >= 0 ? 'rgba(52,199,123,0.15)' : 'rgba(229,72,77,0.15)';

  // Date labels (show first, middle, last)
  const labelIdxs = [0, Math.floor(points.length / 2), points.length - 1];
  const fmtDate = (d) => {
    const parts = d.split('/');
    return `${parts[0]}/${parts[1]}`;
  };

  return (
    <div className="chart" style={{ display: 'block', padding: '14px 14px 10px' }}>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 4 }}>
        <span style={{ font: '600 11px/1 var(--mono)', color: lineColor }}>{current >= 0 ? '+' : ''}{current.toFixed(2)}u</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: '100%', height: '100%', display: 'block' }}>
        {/* Zero line */}
        <line x1={PAD_L} y1={zeroY} x2={W - PAD_R} y2={zeroY} stroke="#2A3138" strokeWidth="1" strokeDasharray="3,3" />
        {/* Y-axis labels */}
        <text x={PAD_L - 4} y={PAD_T + 4} fill="#7C848F" fontSize="8" textAnchor="end">{maxV >= 0 ? '+' : ''}{maxV.toFixed(1)}</text>
        <text x={PAD_L - 4} y={zeroY + 3} fill="#7C848F" fontSize="8" textAnchor="end">0</text>
        <text x={PAD_L - 4} y={H - PAD_B} fill="#7C848F" fontSize="8" textAnchor="end">{minV.toFixed(1)}</text>
        {/* Fill area */}
        <path d={areaD} fill={fillColor} />
        {/* Line */}
        <path d={pathD} fill="none" stroke={lineColor} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        {/* End dot */}
        <circle cx={x(points.length - 1)} cy={y(current)} r="3" fill={lineColor} />
        {/* Date labels */}
        {labelIdxs.map(i => (
          <text key={i} x={x(i)} y={H - 4} fill="#7C848F" fontSize="8" textAnchor="middle">{fmtDate(points[i].date)}</text>
        ))}
      </svg>
    </div>
  );
}

// ── Results Tab (Direction A — Tape) ──────────────────────────────────
function ResultsTab({ results, gradedProps, isBet, isPropBet, lastUpdated, onChangelog }) {
  const [viewType, setViewType] = useState('Games');
  const [range, setRange] = useState('Last 30 Days');
  const [sf, setSf] = useState('All');
  // Re-price comparison: recompute the graded window as if every bet had been
  // a flat 0.20u, to see whether the model's own sizing is earning its keep.
  // Read-only — never touches how history was actually bet (that's stake(),
  // which this tab deliberately does not use).
  const [priceAt, setPriceAt] = useState(null); // null = as bet, or 0.20
  const priceable = (r) => (r.units || 0) > 0;

  const now = new Date();
  const todayStr = `${now.getMonth() + 1}/${now.getDate()}/${now.getFullYear()}`;
  const yesterday = new Date(now); yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = `${yesterday.getMonth() + 1}/${yesterday.getDate()}/${yesterday.getFullYear()}`;
  const weekAgo = new Date(now); weekAgo.setDate(weekAgo.getDate() - 7);
  const monthAgo = new Date(now); monthAgo.setDate(monthAgo.getDate() - 30);

  const parseDate = (d) => {
    if (!d) return null;
    const parts = d.split('/');
    if (parts.length !== 3) return null;
    return new Date(parseInt(parts[2]), parseInt(parts[0]) - 1, parseInt(parts[1]));
  };
  const dateMatch = (r) => {
    if (range === 'Today') return r.date === todayStr;
    if (range === 'Yesterday') return r.date === yesterdayStr;
    if (range === 'Last 7 Days') { const d = parseDate(r.date); return d && d >= weekAgo; }
    if (range === 'Last 30 Days') { const d = parseDate(r.date); return d && d >= monthAgo; }
    return true;
  };

  const showProps = viewType === 'Props';
  const allLeagues = [...new Set([...results.map(r => r.league), ...(gradedProps || []).map(r => r.league)])].filter(Boolean);

  const filteredGames = showProps ? [] : results.filter(r => {
    if (!dateMatch(r)) return false;
    if (sf === 'My Bets') return isBet(r);
    if (sf !== 'All' && r.league !== sf) return false;
    return true;
  });
  const filteredProps = !showProps ? [] : (gradedProps || []).filter(r => {
    if (!dateMatch(r)) return false;
    if (sf === 'My Bets') return isPropBet(r);
    if (sf !== 'All' && r.league !== sf) return false;
    return true;
  });
  const filtered = showProps ? filteredProps : filteredGames;

  const rangeGames = showProps ? [] : results.filter(dateMatch);
  const rangeProps = !showProps ? [] : (gradedProps || []).filter(dateMatch);
  const rangeAll = showProps ? rangeProps : rangeGames;
  const leagueCount = (l) => rangeAll.filter(r => r.league === l).length;

  // Record and Win % are identical by construction whether priced or as-bet —
  // same bets, same outcomes — so they always read off `filtered` directly.
  const wins = filtered.filter(r => r.result === 'W').length;
  const losses = filtered.filter(r => r.result === 'L').length;
  const pushes = filtered.filter(r => r.result === 'P').length;
  const winPct = wins + losses > 0 ? ((wins / (wins + losses)) * 100).toFixed(1) : '0.0';

  // Units/ROI: as-bet always (for the delta baseline), plus the active
  // (possibly re-priced) figures actually shown. A unitReturn:unit ratio
  // scales exactly for win/loss/push, no odds lookup needed — but a
  // zero-units row can't be scaled, so re-priced mode excludes it from both
  // totals entirely rather than dividing by zero or mixing an unscaled
  // straggler into a supposedly-flat total.
  const zeroUnitCount = filtered.filter(r => !priceable(r)).length;
  const pricedRows = priceAt ? filtered.filter(priceable) : filtered;
  const rowReturn = (r) => priceAt ? (r.unitReturn || 0) * (priceAt / r.units) : (r.unitReturn || 0);
  const rowWager = (r) => priceAt ? priceAt : (r.units || 0);
  const totalReturn = pricedRows.reduce((s, r) => s + rowReturn(r), 0);
  const totalWagered = pricedRows.reduce((s, r) => s + rowWager(r), 0);
  const roi = totalWagered > 0 ? ((totalReturn / totalWagered) * 100).toFixed(1) : '0.0';
  const asBetReturn = filtered.reduce((s, r) => s + (r.unitReturn || 0), 0);
  const asBetWagered = filtered.reduce((s, r) => s + (r.units || 0), 0);
  const roiAsBet = asBetWagered > 0 ? (asBetReturn / asBetWagered) * 100 : 0;
  const chartResults = priceAt ? pricedRows.map(r => ({ ...r, unitReturn: rowReturn(r) })) : filtered;

  const byDate = {};
  for (const r of filtered) { if (!byDate[r.date]) byDate[r.date] = []; byDate[r.date].push(r); }
  const sortedDates = Object.keys(byDate).sort((a, b) => {
    const da = parseDate(a), db = parseDate(b);
    return (db?.getTime() || 0) - (da?.getTime() || 0);
  });

  return (
    <div className="tp">
      <div className="ah"><b>Results</b><span>{rangeAll.length} GRADED</span></div>

      <div className="rangerow">
        {[['Today', 'Today'], ['Yesterday', 'Yest'], ['Last 7 Days', '7d'], ['Last 30 Days', '30d'], ['All Time', 'All']].map(([val, label]) => (
          <button key={val} className={range === val ? 'on' : ''} onClick={() => setRange(val)}>{label}</button>
        ))}
      </div>

      <div className="priced">
        <span className="pl">
          {priceAt ? `Re-priced at ${priceAt.toFixed(2)}u · view only` : 'Priced as bet'}
          {priceAt && zeroUnitCount > 0 ? ` · ${zeroUnitCount} zero-unit row${zeroUnitCount > 1 ? 's' : ''} excluded` : ''}
        </span>
        <span className="pr">
          <button className={!priceAt ? 'on' : ''} onClick={() => setPriceAt(null)}>As bet</button>
          <button className={priceAt ? 'on' : ''} onClick={() => setPriceAt(0.20)}>At 0.20u</button>
        </span>
      </div>

      <div className="agrid">
        <div><span className="k">Record</span><span className={`v${priceAt ? ' same' : ''}`}>{wins}–{losses}{pushes ? <s>–{pushes}</s> : null}</span></div>
        <div><span className="k">Win %</span><span className={`v${priceAt ? ' same' : ''}`}>{winPct}</span></div>
        <div><span className="k">Units</span><span className={`v ${totalReturn >= 0 ? 'up' : 'dn'}`}>{totalReturn >= 0 ? '+' : ''}{totalReturn.toFixed(1)}</span></div>
        <div>
          <span className="k">ROI</span>
          <span className={`v ${parseFloat(roi) >= 0 ? 'up' : 'dn'}`}>{parseFloat(roi) >= 0 ? '+' : ''}{roi}%</span>
          {priceAt && <span className="d">{`${(parseFloat(roi) - roiAsBet >= 0 ? '+' : '')}${(parseFloat(roi) - roiAsBet).toFixed(1)} vs as bet`}</span>}
        </div>
      </div>

      <div className="datepick">
        {['Games', 'Props'].map(v => (
          <button key={v} className={viewType === v ? 'on' : ''} onClick={() => setViewType(v)}>{v}</button>
        ))}
        {onChangelog && <button onClick={onChangelog}>Changelog</button>}
      </div>

      <div className="aleagues">
        <button className={sf === 'All' ? 'sel' : ''} onClick={() => setSf('All')}><span className="lg">ALL</span><span className="ct">{rangeAll.length}</span></button>
        <button className={sf === 'My Bets' ? 'sel' : ''} onClick={() => setSf('My Bets')}><span className="lg">MINE</span><span className="ct">{rangeAll.filter(showProps ? isPropBet : isBet).length}</span></button>
        {allLeagues.map(l => (
          <button key={l} className={sf === l ? 'sel' : ''} onClick={() => setSf(l)}><span className="lg">{l}</span><span className="ct">{leagueCount(l)}</span></button>
        ))}
      </div>

      {filtered.length >= 2 && (
        <div style={{ position: 'relative' }}>
          <span style={{ position: 'absolute', top: 12, right: 14, font: '500 9px/1 var(--mono)', letterSpacing: '.1em', color: 'var(--dim2)', zIndex: 1 }}>UNIT CURVE</span>
          <UnitsChart results={chartResults} />
        </div>
      )}

      {!filtered.length && <div className="empty">{showProps ? 'No graded prop results for this period.' : 'No graded results for this period.'}</div>}

      {sortedDates.map(date => {
        const bets = byDate[date];
        const dayReturn = bets.reduce((s, r) => s + (r.unitReturn || 0), 0);
        const graded = bets.length;
        return (
          <div key={date}>
            <div className="dayh">
              <span className="d">{date} · {graded} graded</span>
              <span className={`t num ${dayReturn >= 0 ? '' : ''}`} style={{ color: dayReturn >= 0 ? 'var(--win)' : 'var(--loss)' }}>{dayReturn >= 0 ? '+' : ''}{dayReturn.toFixed(2)}u</span>
            </div>
            {showProps ? bets.map((r, j) => (
              <div key={j} className="lr">
                <span className={`res ${r.result === 'W' ? 'w' : r.result === 'L' ? 'l' : 'p'}`}>{r.result}</span>
                <span className="tmini"><span style={{ fontSize: 6, fontWeight: 700, color: 'var(--dim)' }}>{(r.league || '').slice(0, 3)}</span></span>
                <span className="nm">{r.player} <span>· {r.direction} {r.line}{r.edge ? ` · ${r.edge}% edge` : ''}</span></span>
                <span className="pr">{r.bookOdds ? fmt(r.bookOdds) : ''}</span>
                <span className={`un ${r.result === 'W' ? 'w' : r.result === 'L' ? 'l' : 'p'}`}>{r.unitReturn >= 0 ? '+' : ''}{(r.unitReturn || 0).toFixed(2)}</span>
              </div>
            )) : bets.map((r, j) => {
              const url = teamLogo(r.pick, r.league);
              return (
                <div key={j} className="lr">
                  <span className={`res ${r.result === 'W' ? 'w' : r.result === 'L' ? 'l' : 'p'}`}>{r.result}</span>
                  <span className="tmini">{url ? <img src={url} alt="" /> : <span style={{ fontSize: 6, fontWeight: 700, color: 'var(--dim)' }}>{(r.league || '').slice(0, 3)}</span>}</span>
                  <span className="nm">{r.pick}{r.line ? ` ${r.line}` : ''} <span>· {isBet(r) ? 'my bet' : r.league}</span></span>
                  <span className="pr">{fmt(r.odds)}</span>
                  <span className={`un ${r.result === 'W' ? 'w' : r.result === 'L' ? 'l' : 'p'}`}>{r.unitReturn >= 0 ? '+' : ''}{(r.unitReturn || 0).toFixed(2)}</span>
                </div>
              );
            })}
          </div>
        );
      })}

    </div>
  );
}

// ── Live Scores Fetcher (ESPN) ──────────────────────────────────────
async function fetchLiveScores() {
  const games = [];
  // Fetch all four leagues in PARALLEL (was sequential await-in-loop, which
  // made the Scores tab wait on 4 round-trips in series).
  await Promise.all(Object.entries(ESPN_SPORTS).map(async ([league, cfg]) => {
    try {
      const res = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${cfg.key}/${cfg.league}/scoreboard`);
      if (!res.ok) return;
      const data = await res.json();
      for (const event of (data.events || [])) {
        const comp = event.competitions?.[0];
        if (!comp) continue;
        const homeTeam = comp.competitors?.find(c => c.homeAway === 'home');
        const awayTeam = comp.competitors?.find(c => c.homeAway === 'away');
        const status = event.status?.type?.state;
        const period = event.status?.type?.shortDetail || '';
        const clock = event.status?.displayClock || '';
        const periodNum = event.status?.period || 0;

        let isLate = false;
        if (league === 'NBA' && periodNum >= 4) isLate = true;
        if (league === 'NHL' && periodNum >= 3) isLate = true;
        if (league === 'NFL' && periodNum >= 4) isLate = true;
        if (league === 'MLB' && periodNum >= 7) isLate = true;
        if (isSoccer(league) && periodNum >= 2) isLate = true;

        // Detect postponed/canceled/suspended
        const statusName = event.status?.type?.name || '';  // e.g. 'STATUS_POSTPONED', 'STATUS_CANCELED'
        const isPostponed = statusName.includes('POSTPONED') || statusName.includes('CANCELED') || statusName.includes('SUSPENDED');
        const statusDescription = event.status?.type?.description || '';
        
        // Doubleheader: ESPN uses notes to indicate Game 1/Game 2
        const notes = event.competitions?.[0]?.notes || [];
        const gameNote = notes.find(n => /game\s*[12]/i.test(n.headline || ''));
        const gameNum = gameNote ? (gameNote.headline.match(/game\s*(\d)/i)?.[1] || null) : null;

        // Extract probable pitchers for MLB pre-game
        let homePitcher = null, awayPitcher = null;
        if (league === 'MLB' && status === 'pre') {
          const extractPitcher = (team) => {
            const p = team?.probables?.[0];
            if (!p?.athlete) return null;
            const era = p.statistics?.find(s => s.name === 'ERA')?.displayValue;
            const w = p.statistics?.find(s => s.name === 'wins')?.displayValue;
            const l = p.statistics?.find(s => s.name === 'losses')?.displayValue;
            return { name: p.athlete.shortName, era: era || null, record: (w && l) ? `${w}-${l}` : null };
          };
          homePitcher = extractPitcher(homeTeam);
          awayPitcher = extractPitcher(awayTeam);
        }

        // Extract linescores (period-by-period scoring)
        const homeLinescores = (homeTeam?.linescores || []).map(l => l.value ?? 0);
        const awayLinescores = (awayTeam?.linescores || []).map(l => l.value ?? 0);

        // Extract leaders (top performers per category)
        const leaders = [];
        for (const team of [awayTeam, homeTeam]) {
          for (const cat of (team?.leaders || [])) {
            const top = cat.leaders?.[0];
            if (top) {
              leaders.push({
                category: cat.displayName || cat.name || '',
                shortCategory: cat.abbreviation || cat.name || '',
                athlete: top.athlete?.shortName || top.athlete?.displayName || '',
                value: top.displayValue || top.value || '',
                team: team?.team?.abbreviation || '',
              });
            }
          }
        }

        // Extract venue/broadcast
        const venue = comp.venue?.fullName || '';
        const broadcast = comp.broadcasts?.[0]?.names?.[0] || '';
        const odds = comp.odds?.[0]?.details || '';

        // Extract game situation (last play, sport-specific context)
        const sit = comp.situation || {};
        const lastPlay = sit.lastPlay?.text || '';
        const lastPlayScore = sit.lastPlay?.scoreValue || 0;
        let situation = null;
        if (status === 'in' || status === 'post') {
          situation = { lastPlay, lastPlayScore };
          if (league === 'MLB') {
            situation.outs = sit.outs ?? null;
            situation.onFirst = !!sit.onFirst;
            situation.onSecond = !!sit.onSecond;
            situation.onThird = !!sit.onThird;
            situation.batter = sit.batter?.athlete?.shortName || '';
            situation.pitcher = sit.pitcher?.athlete?.shortName || '';
          }
          if (league === 'NFL') {
            situation.downDistance = sit.downDistanceText || '';
            situation.possession = sit.possession || '';
            situation.isRedZone = !!sit.isRedZone;
            situation.yardLine = sit.yardLine || '';
          }
          if (league === 'NBA' || league === 'NHL') {
            situation.possession = sit.possession || '';
          }
        }

        games.push({
          league,
          eventId: event.id,
          gameDate: event.date || comp.date || '',
          home: homeTeam?.team?.displayName || '',
          away: awayTeam?.team?.displayName || '',
          homeScore: parseInt(homeTeam?.score) || 0,
          awayScore: parseInt(awayTeam?.score) || 0,
          homeRecord: homeTeam?.records?.[0]?.summary || '',
          awayRecord: awayTeam?.records?.[0]?.summary || '',
          homeLinescores,
          awayLinescores,
          leaders,
          venue,
          broadcast,
          odds,
          situation,
          status: isPostponed ? 'postponed' : status,
          statusDetail: isPostponed ? (statusDescription || statusName.replace('STATUS_', '')) : '',
          period,
          periodNum,
          clock,
          isLate,
          gameNum: gameNum ? parseInt(gameNum) : null,
          homePitcher,
          awayPitcher,
        });
      }
    } catch (e) { /* skip */ }
  }));
  return games;
}

// ── Live Prop Stats (ESPN Box Scores) ───────────────────────────────
function extractStat(market, labels, stats) {
  const m = (market || '').toLowerCase().replace(/\s+/g, '_');
  const getStat = (label) => {
    const idx = labels.indexOf(label);
    if (idx === -1) return 0;
    const val = stats[idx];
    if (!val || val === '-' || val === '--') return 0;
    // Handle "made-attempted" format like "3-7" for 3PT, FG
    if (typeof val === 'string' && val.includes('-') && !val.startsWith('-') && !val.includes(':')) {
      return parseInt(val.split('-')[0]) || 0;
    }
    return parseFloat(val) || 0;
  };

  // Combo markets (check these first)
  if (m.includes('points') && m.includes('rebounds') && m.includes('assists')) return getStat('PTS') + getStat('REB') + getStat('AST');
  if (m.includes('points') && m.includes('rebounds')) return getStat('PTS') + getStat('REB');
  if (m.includes('points') && m.includes('assists')) return getStat('PTS') + getStat('AST');
  if (m.includes('rebounds') && m.includes('assists')) return getStat('REB') + getStat('AST');
  // Single stat markets
  if (m.includes('points') || m.includes('pts')) return getStat('PTS');
  if (m.includes('rebounds') || m.includes('reb')) return getStat('REB');
  if (m.includes('assists') || m.includes('ast')) return getStat('AST') || getStat('A');
  if (m.includes('threes') || m.includes('three') || m.includes('3pt')) return getStat('3PT');
  if (m.includes('steals')) return getStat('STL');
  if (m.includes('blocks') || m.includes('blk')) return getStat('BLK');
  if (m.includes('turnovers')) return getStat('TO');
  if (m.includes('hits') || m === 'batter_hits') return getStat('H');
  if (m.includes('total_bases')) return getStat('TB');
  if (m.includes('home_runs') || m.includes('hr')) return getStat('HR');
  if (m.includes('rbis') || m.includes('rbi')) return getStat('RBI');
  if (m.includes('strikeouts') || m === 'pitcher_strikeouts') return getStat('K') || getStat('SO');
  if (m.includes('goals')) return getStat('G');
  if (m.includes('shots_on_goal') || m.includes('sog')) return getStat('SOG') || getStat('S');
  if (m.includes('saves')) return getStat('SV');
  return null;
}

async function fetchBoxScore(eventId, sport, leagueKey) {
  try {
    const res = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${sport}/${leagueKey}/summary?event=${eventId}`);
    if (!res.ok) return null;
    const data = await res.json();
    const players = {};
    const boxPlayers = data?.boxscore?.players || [];
    for (const team of boxPlayers) {
      for (const statGroup of (team.statistics || [])) {
        const labels = statGroup.labels || [];
        for (const athlete of (statGroup.athletes || [])) {
          const name = athlete.athlete?.displayName || '';
          const shortName = athlete.athlete?.shortName || '';
          const statVals = athlete.stats || [];
          if (name && labels.length) {
            const entry = { labels, stats: statVals, name };
            players[name.toLowerCase()] = entry;
            if (shortName) players[shortName.toLowerCase()] = entry;
            // Last name for fuzzy matching
            const parts = name.split(' ');
            if (parts.length > 1) {
              const last = parts.slice(-1)[0].toLowerCase();
              if (!players[last]) players[last] = entry;
            }
          }
        }
      }
    }
    return players;
  } catch (e) { return null; }
}

function matchPropToGame(prop, liveGames) {
  const gameStr = (prop.game || '').toLowerCase();
  return liveGames.find(g => {
    if (g.league !== prop.league) return false;
    const homeShort = g.home.split(' ').pop().toLowerCase();
    const awayShort = g.away.split(' ').pop().toLowerCase();
    return gameStr.includes(homeShort) && gameStr.includes(awayShort);
  });
}

function findPlayerStat(playerName, market, boxPlayers) {
  if (!boxPlayers || !playerName) return null;
  const name = playerName.toLowerCase().trim();
  // Try exact, then short name, then last name
  let found = boxPlayers[name];
  if (!found) {
    const lastName = name.split(' ').pop();
    found = boxPlayers[lastName];
    if (!found) {
      // Partial match
      for (const [key, val] of Object.entries(boxPlayers)) {
        if (key.includes(name) || name.includes(key)) { found = val; break; }
      }
    }
  }
  if (!found) return null;
  const val = extractStat(market, found.labels, found.stats);
  return val !== null ? { current: val, playerFound: found.name } : null;
}

// ── Main App ────────────────────────────────────────────────────────
// ── Settings Tab ──────────────────────────────────────────────────────
function SettingsTab() {
  const [confirmReview, setConfirmReview] = useState(false);
  const [reviewStatus, setReviewStatus] = useState(null);
  const [ghToken, setGhToken] = useState(() => {
    try { return (typeof window !== "undefined" && localStorage.getItem("shadowbets_gh_token")) || ""; } catch { return ""; }
  });
  const [tokenSaved, setTokenSaved] = useState(() => {
    try { return !!(typeof window !== "undefined" && localStorage.getItem("shadowbets_gh_token")); } catch { return false; }
  });

  const saveToken = () => {
    if (ghToken.startsWith("ghp_")) {
      try { localStorage.setItem("shadowbets_gh_token", ghToken); } catch {}
      setTokenSaved(true);
    }
  };

  const clearToken = () => {
    try { localStorage.removeItem("shadowbets_gh_token"); } catch {}
    setGhToken("");
    setTokenSaved(false);
  };

  const triggerSystemCheck = async () => {
    if (!ghToken) { setReviewStatus("error"); return; }
    setReviewStatus("sending");
    try {
      const resp = await fetch(
        "https://api.github.com/repos/nickciesinski/ShadowB/actions/workflows/system-check.yml/dispatches",
        { method: "POST", headers: { Authorization: `token ${ghToken}`, Accept: "application/vnd.github.v3+json" }, body: JSON.stringify({ ref: "main" }) }
      );
      if (resp.status === 204 || resp.ok) { setReviewStatus("sent"); setConfirmReview(false); }
      else { setReviewStatus("error"); }
    } catch { setReviewStatus("error"); }
  };

  const cardStyle = { background: "rgba(255,255,255,0.04)", borderRadius: 14, border: "1px solid rgba(255,255,255,0.06)", marginBottom: 10, overflow: "hidden" };

  return (
    <div>
      {/* GitHub Token */}
      {!tokenSaved && (
        <div style={cardStyle}>
          <div style={{ padding: "14px 16px" }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: "#F1F5F9", marginBottom: 6 }}>Connect GitHub</div>
            <div style={{ fontSize: 12, color: "#64748B", marginBottom: 10 }}>Enter your PAT to enable workflow triggers.</div>
            <input
              type="password"
              placeholder="ghp_..."
              value={ghToken}
              onChange={e => setGhToken(e.target.value)}
              style={{ width: "100%", padding: "10px 12px", borderRadius: 8, border: "1px solid rgba(255,255,255,0.1)", background: "rgba(255,255,255,0.06)", color: "#F1F5F9", fontSize: 14, fontFamily: "monospace", marginBottom: 8, boxSizing: "border-box", outline: "none" }}
            />
            <button onClick={saveToken} disabled={!ghToken.startsWith("ghp_")} style={{ width: "100%", padding: "10px 0", borderRadius: 8, border: "none", background: ghToken.startsWith("ghp_") ? "#10B981" : "rgba(255,255,255,0.06)", color: ghToken.startsWith("ghp_") ? "white" : "#475569", fontSize: 14, fontWeight: 700, cursor: ghToken.startsWith("ghp_") ? "pointer" : "default" }}>Save Token</button>
          </div>
        </div>
      )}
      {tokenSaved && (
        <div style={{ background: "rgba(16,185,129,0.1)", borderRadius: 8, padding: "8px 12px", marginBottom: 10, fontSize: 12, color: "#34D399", fontWeight: 600, display: "flex", alignItems: "center", gap: 6 }}>
          <span>✓</span> GitHub connected
          <button onClick={clearToken} style={{ marginLeft: "auto", background: "none", border: "none", color: "#64748B", fontSize: 11, cursor: "pointer", textDecoration: "underline" }}>Reset</button>
        </div>
      )}

      {/* Section Label */}
      <div style={{ fontSize: 10, fontWeight: 700, color: "#475569", textTransform: "uppercase", padding: "10px 2px 6px", letterSpacing: 1 }}>Actions</div>

      {/* System Review */}
      <div style={cardStyle}>
        <button onClick={() => { if (reviewStatus === "sent") { setReviewStatus(null); return; } setConfirmReview(true); }} disabled={!tokenSaved || reviewStatus === "sending"} style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 16px", background: "none", border: "none", cursor: tokenSaved ? "pointer" : "default", opacity: tokenSaved ? 1 : 0.4 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ width: 36, height: 36, borderRadius: 10, background: "rgba(75,156,211,0.15)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18 }}>🔍</span>
            <div style={{ textAlign: "left" }}>
              <div style={{ fontSize: 15, fontWeight: 600, color: "#F1F5F9" }}>System Review</div>
              <div style={{ fontSize: 12, color: "#64748B" }}>Health check + performance report via email</div>
            </div>
          </div>
          <div>
            {reviewStatus === "sending" && <span style={{ fontSize: 12, color: "#64748B" }}>Sending...</span>}
            {reviewStatus === "sent" && <span style={{ fontSize: 12, color: "#34D399", fontWeight: 600 }}>✓ Queued</span>}
            {reviewStatus === "error" && <span style={{ fontSize: 12, color: "#F87171" }}>Failed</span>}
            {!reviewStatus && <span style={{ color: "#334155", fontSize: 18 }}>›</span>}
          </div>
        </button>
        {confirmReview && (
          <div style={{ borderTop: "1px solid rgba(255,255,255,0.06)", padding: "12px 16px", background: "rgba(255,255,255,0.02)" }}>
            <div style={{ fontSize: 13, color: "#94A3B8", marginBottom: 10 }}>Run a full system health check and email a performance report (3/7/15/30-day windows)?</div>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => setConfirmReview(false)} style={{ flex: 1, padding: "10px 0", borderRadius: 8, border: "1px solid rgba(255,255,255,0.1)", background: "transparent", color: "#94A3B8", fontSize: 14, fontWeight: 600, cursor: "pointer" }}>Cancel</button>
              <button onClick={triggerSystemCheck} style={{ flex: 1, padding: "10px 0", borderRadius: 8, border: "none", background: "#8B5CF6", color: "white", fontSize: 14, fontWeight: 700, cursor: "pointer" }}>Send Review</button>
            </div>
          </div>
        )}
      </div>

      {/* System Info */}
      <div style={{ fontSize: 10, fontWeight: 700, color: "#475569", textTransform: "uppercase", padding: "14px 2px 6px", letterSpacing: 1 }}>System</div>
      <div style={cardStyle}>
        <div style={{ padding: "4px 16px" }}>
          {[{ l: "Runtime", v: "GitHub Actions · Node 22" }, { l: "Data", v: "Google Sheets · 47 tabs" }, { l: "Compute", v: "Supabase (Postgres)" }, { l: "Triggers", v: "17 workflows" }, { l: "Model", v: "Deterministic + 6-factor props" }].map((item, i, arr) => (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "10px 0", borderBottom: i < arr.length - 1 ? "1px solid rgba(255,255,255,0.04)" : "none" }}>
              <span style={{ fontSize: 13, color: "#64748B" }}>{item.l}</span>
              <span style={{ fontSize: 13, color: "#E2E8F0", fontWeight: 600 }}>{item.v}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// Placeholder card grid shown while data/scores load — gives instant structure
// instead of a blank "Loading..." so the app feels responsive immediately.
function LoadingSkeleton() {
  const bar = (w, h, o) => ({ width: w, height: h, borderRadius: 4, background: `rgba(255,255,255,${o})` });
  const cards = [0, 1, 2, 3, 4, 5].map(i => (
    <div key={i} style={{
      background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)',
      borderRadius: 12, padding: 12, animation: 'shimmer 1.4s ease-in-out infinite', animationDelay: `${i * 0.08}s`,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
        <div style={bar(34, 12, 0.08)} />
        <div style={bar(44, 10, 0.06)} />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <div style={bar(88, 12, 0.09)} />
        <div style={bar(18, 14, 0.09)} />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div style={bar(76, 12, 0.09)} />
        <div style={bar(18, 14, 0.09)} />
      </div>
      <div style={{ display: 'flex', gap: 6, justifyContent: 'center' }}>
        <div style={{ width: 16, height: 16, borderRadius: '50%', background: 'rgba(255,255,255,0.07)' }} />
        <div style={{ width: 16, height: 16, borderRadius: '50%', background: 'rgba(255,255,255,0.07)' }} />
        <div style={{ width: 16, height: 16, borderRadius: '50%', background: 'rgba(255,255,255,0.07)' }} />
      </div>
    </div>
  ));
  return <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8, marginTop: 4 }}>{cards}</div>;
}

export default function App() {
  // Default tab: Picks in the early morning, Scores from 9am PT onward.
  // Computed in PT explicitly (matching the backend's America/Los_Angeles day
  // rollover) so it's consistent regardless of the device's timezone.
  const getDefaultTab = () => {
    const ptHour = new Date(
      new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })
    ).getHours();
    return ptHour < 9 ? 'picks' : 'scores';
  };

  const [tab, setTab] = useState(getDefaultTab);
  const [sf, setSf] = useState('All'); // Props tab league/My-Bets filter only — Picks/Scores/Results manage their own now
  const [pf, setPf] = useState('All');
  // My Bets — persisted to localStorage, auto-resets daily
  // Map<key, 'bet' | 'fade'> — 'bet' = tailed the pick, 'fade' = bet the opposite
  const [myBets, setMyBets] = useState(() => {
    try {
      const saved = typeof window !== 'undefined' && localStorage.getItem('shadowbets_mybets');
      if (saved) {
        const { date, bets } = JSON.parse(saved);
        const today = new Date().toLocaleDateString();
        if (date === today) {
          // Support old Set format (array of strings) and new Map format (array of [key, val])
          if (Array.isArray(bets) && bets.length > 0 && Array.isArray(bets[0])) {
            return new Map(bets);
          }
          // Legacy: convert old Set to Map (all as 'bet')
          return new Map(bets.map(k => [k, 'bet']));
        }
      }
    } catch (e) {}
    return new Map();
  });
  // Flat unit sizing — while the model's own sizing is still being tuned, Nick
  // bets a flat stake on every play instead. 'model' reads p.units (the
  // model's conviction) as the stake; a number overrides it. Conviction
  // itself (tier bar, sort, 0.3u+ filter) always reads p.units regardless —
  // this only ever swaps what counts as MONEY. See stake() below.
  const SIZING_PRESETS = ['model', 0.10, 0.20, 0.50];
  const [sizing, setSizing] = useState('model');
  // See pickModeWriteSkip above — same race, same fix: skip the write-effect's
  // mount-time run so it can't overwrite the saved value with the default
  // before the read-effect's setSizing has taken effect.
  const sizingWriteSkip = useRef(true);
  useEffect(() => {
    try {
      const saved = localStorage.getItem('sb.sizing');
      if (saved) setSizing(saved === 'model' ? 'model' : parseFloat(saved));
    } catch (e) {}
  }, []);
  useEffect(() => {
    if (sizingWriteSkip.current) { sizingWriteSkip.current = false; return; }
    try { localStorage.setItem('sb.sizing', String(sizing)); } catch (e) {}
  }, [sizing]);
  // The actual money stake for a pick. A locked entry (stamped at the moment
  // it became a real position — see setPickState/commitTake) always prices at
  // whatever sizing was active then, regardless of what the toggle reads now;
  // only a pick with no entry yet takes the current sizing live.
  const stake = (p) => {
    const v = myBets.get(pickKey(p));
    if (v) return entryStake(v, p);
    return sizing === 'model' ? (p.units || 0) : sizing;
  };
  // Picks tape mode — 'build' (triaging the morning slate) or 'watch' (locked,
  // read-only). Persisted per-day so a reload after locking stays in watch mode.
  // Always starts 'build' (matching the server-rendered HTML) and is restored
  // from localStorage in an effect — reading localStorage inside the useState
  // initializer would make the client's first render disagree with the
  // server's and throw a React hydration-mismatch error every day after lock.
  const [pickMode, setPickMode] = useState('build');
  // Both effects below run on the same initial mount. Without this guard, the
  // write-effect's first run fires with the just-declared default ('build')
  // — before the read-effect's setPickMode has taken effect — and clobbers
  // today's already-saved 'watch' with 'build' on every reload. Skip exactly
  // one write: the one from mount.
  const pickModeWriteSkip = useRef(true);
  useEffect(() => {
    try {
      const saved = localStorage.getItem('shadowbets_pickmode');
      if (saved) {
        const { date, mode } = JSON.parse(saved);
        if (date === new Date().toLocaleDateString()) setPickMode(mode);
      }
    } catch (e) {}
  }, []);
  const [tierThreshold, setTierThreshold] = useState(7);
  useEffect(() => {
    if (pickModeWriteSkip.current) { pickModeWriteSkip.current = false; return; }
    try {
      localStorage.setItem('shadowbets_pickmode', JSON.stringify({ date: new Date().toLocaleDateString(), mode: pickMode }));
    } catch (e) {}
  }, [pickMode]);

  // Cross-device sync: today's myBets/pickMode also live in Supabase
  // (daily_state, one row per day, last write wins) so a pick tapped on your
  // phone shows up on your computer and vice versa — localStorage above is
  // per-device only. On mount, pull the server's copy if one exists; local
  // state stays authoritative until that resolves, so a blank server row
  // doesn't wipe out picks made on this device moments before the fetch
  // lands. After that, every myBets/pickMode change gets pushed up.
  const [stateSynced, setStateSynced] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const todayIso = new Date().toLocaleDateString('en-CA');
    fetch(`/api/state?date=${todayIso}`)
      .then(r => r.json())
      .then(d => {
        if (cancelled) return;
        if (d.found) {
          setMyBets(new Map(d.myBets || []));
          setPickMode(d.pickMode || 'build');
        }
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setStateSynced(true); });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    if (!stateSynced) return;
    const todayIso = new Date().toLocaleDateString('en-CA');
    fetch('/api/state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: todayIso, myBets: [...myBets.entries()], pickMode }),
    }).catch(() => {});
  }, [stateSynced, myBets, pickMode]);

  // Commit/Undo snapshot for the Picks rule-bar "Take" action — lifted here
  // (rather than owned by PicksTab) so a build→watch→build→watch mode toggle
  // round trip can't overwrite it with post-commit state. Only ever set by an
  // actual commit, and — like pickMode/myBets — implicitly scoped to today
  // since a reload always starts fresh.
  const UNDO_SECONDS = 20;
  const [commitSnapshot, setCommitSnapshot] = useState(null);
  const [committedCount, setCommittedCount] = useState(0);
  const [committedUnits, setCommittedUnits] = useState(0);
  const [undoLeft, setUndoLeft] = useState(0);
  const commitTake = useCallback((commitList) => {
    setCommitSnapshot(myBets);
    setCommittedCount(commitList.length);
    setCommittedUnits(commitList.reduce((s, p) => s + stake(p), 0));
    setMyBets(prev => {
      const next = new Map(prev);
      for (const p of commitList) {
        const key = pickKey(p);
        // Only stamp picks the rule auto-selected and were never manually
        // touched — a manual tap already stamped its own stake the moment it
        // was set (see setPickState), and that's the true "locked at" moment
        // for that pick, not whenever Take happens to get pressed afterward.
        if (!next.has(key)) next.set(key, { state: 'bet', stakeUsed: stake(p), at: Date.now() });
      }
      return next;
    });
    setPickMode('watch');
    setUndoLeft(UNDO_SECONDS);
  }, [myBets, stake]);
  const undoCommit = useCallback(() => {
    if (!commitSnapshot) return;
    setMyBets(commitSnapshot);
    setPickMode('build');
    setCommitSnapshot(null);
    setUndoLeft(0);
  }, [commitSnapshot]);
  useEffect(() => {
    if (!commitSnapshot) return;
    if (undoLeft <= 0) { setCommitSnapshot(null); return; }
    const t = setTimeout(() => setUndoLeft(s => s - 1), 1000);
    return () => clearTimeout(t);
  }, [commitSnapshot, undoLeft]);

  const [propDateFilter, setPropDateFilter] = useState('Today');
  const [picksDateFilter, setPicksDateFilter] = useState('Today');
  const [resultType, setResultType] = useState('Games');
  const [data, setData] = useState(null);
  const [resultsData, setResultsData] = useState(null); // graded history, loaded lazily after main data
  const [resultsError, setResultsError] = useState(false);
  const [liveGames, setLiveGames] = useState([]);
  const [liveStats, setLiveStats] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);

  // Persist myBets to localStorage on change
  useEffect(() => {
    try {
      localStorage.setItem('shadowbets_mybets', JSON.stringify({
        date: new Date().toLocaleDateString(),
        bets: [...myBets.entries()],
      }));
    } catch (e) {}
  }, [myBets]);

  // Three-state toggle: none → bet → fade → none
  const toggleBet = (p) => {
    const key = pickKey(p);
    setMyBets(prev => {
      const next = new Map(prev);
      const cur = entryState(next.get(key));
      if (!cur) next.set(key, { state: 'bet', stakeUsed: stake(p), at: Date.now() });
      else if (cur === 'bet') next.set(key, { state: 'fade', stakeUsed: stake(p), at: Date.now() });
      else next.delete(key);
      return next;
    });
  };
  // Force a pick to a specific state (used by the rule-bar commit flow) —
  // unlike toggleBet this doesn't cycle, it sets directly. 'bet'/'fade' are
  // real positions and get the stake stamped right now, at the moment the
  // tap makes them one — not deferred to whenever Take gets pressed, since a
  // fade never goes through commitTake at all (see PicksTab's tap()).
  // `side` is only passed for 3-way soccer moneylines — it records WHICH of
  // home/draw/away you put yourself on. Omitted everywhere else, where the model
  // has only one side and `state` alone says whether you're with it or against it.
  const setPickState = (p, state, side) => {
    const key = pickKey(p);
    setMyBets(prev => {
      const next = new Map(prev);
      if (!state) next.delete(key);
      else if (state === 'pass') next.set(key, 'pass');
      else next.set(key, { state, side, stakeUsed: stake(p), at: Date.now() });
      return next;
    });
  };
  const toggleProp = (p) => {
    const key = propKey(p);
    setMyBets(prev => {
      const next = new Map(prev);
      const cur = next.get(key);
      const curState = typeof cur === 'object' ? cur.state : cur;
      if (!curState) next.set(key, { state: 'bet', line: p.line, odds: p.bookOdds, player: p.player, league: p.league, market: p.market, direction: p.direction, book: p.book, game: p.game, selectedAt: Date.now() });
      else if (curState === 'bet') next.set(key, { state: 'fade', line: (typeof cur === 'object' ? cur.line : p.line), odds: (typeof cur === 'object' ? cur.odds : p.bookOdds), player: p.player, league: p.league, market: p.market, direction: p.direction, book: p.book, game: p.game, selectedAt: (typeof cur === 'object' ? cur.selectedAt : Date.now()) });
      else next.delete(key);
      return next;
    });
  };
  // Value-specific, not .has() — myBets can also hold an explicit 'pass'
  // entry (a manual exclusion from the Picks threshold rule; see PicksTab's
  // effState), which must never register as a real position anywhere else
  // in the app (Scores, Results, badges, etc.).
  const isBet = (p) => entryState(myBets.get(pickKey(p))) === 'bet';
  const isFade = (p) => entryState(myBets.get(pickKey(p))) === 'fade';
  // Resolves a pick to the side you're actually on, and is handed to every tab so
  // one position can't read as Draw on Picks and as the home team on Scores.
  // Pass `allPicks` where the full slate is in hand (lets the two-way path find a
  // real opposite-side row instead of approximating one).
  const displayPick = (p, allPicks) => displayPickFor(p, myBets.get(pickKey(p)), allPicks);
  const isPropBet = (p) => {
    const v = myBets.get(propKey(p));
    return !!v;
  };
  const isPropFade = (p) => {
    const v = myBets.get(propKey(p));
    return (typeof v === 'object' ? v.state : v) === 'fade';
  };
  // Get all stored prop bets for "My Bets" view
  // Lock all picks above threshold (for morning quick-lock)
  const lockAll = useCallback(() => {
    if (!data?.todayPicks) return;
    // "Morning quick-lock" is a today-only action — scope it to today's picks even
    // though data.todayPicks now spans the next week (soccer's CLV lookahead).
    const todaysOnly = data.todayPicks.filter(p => !p.isoDate || p.isoDate === new Date().toLocaleDateString('en-CA'));
    const qualified = dedup(todaysOnly).filter(p => p.units >= 0.2);
    setMyBets(prev => {
      const next = new Map(prev);
      for (const p of qualified) {
        const key = pickKey(p);
        if (!next.has(key)) next.set(key, { state: 'bet', stakeUsed: stake(p), at: Date.now() });
      }
      return next;
    });
  }, [data?.todayPicks, stake]);

  const getMyPropBets = () => {
    const result = [];
    for (const [key, val] of myBets.entries()) {
      if (!key.startsWith('prop|')) continue;
      const obj = typeof val === 'object' ? val : { state: val };
      if (obj.player) result.push({ ...obj, _key: key });
    }
    return result;
  };

  // Fetch sheet data
  const fetchData = useCallback(() => {
    fetch('/api/data')
      .then(r => r.json().then(d => { if (!r.ok || d?.error) throw new Error(d?.error || `HTTP ${r.status}`); return d; }))
      .then(d => { setData(d); setLoading(false); setLastUpdated(new Date()); })
      .catch(e => { setError(e.message); setLoading(false); });
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  // Fetch graded history (Results tab) lazily — never blocks the main load.
  const fetchResults = useCallback(() => {
    fetch('/api/results')
      .then(r => r.json().then(d => { if (!r.ok || d?.error) throw new Error(d?.error || `HTTP ${r.status}`); return d; }))
      .then(d => { setResultsData(d); setResultsError(false); })
      .catch(() => { setResultsError(true); }); // existing resultsData (if any) stays intact; main app unaffected
  }, []);

  // Kick off the results fetch once, right AFTER the main data has arrived.
  useEffect(() => {
    if (data && resultsData === null) fetchResults();
  }, [data, resultsData, fetchResults]);

  // Re-fetch data when app becomes visible (switching back to tab/app).
  // Also refresh graded results so they stay current as games finish through
  // the day. fetchResults leaves existing data intact on failure, so a
  // transient error on refocus won't blank the Results tab.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        fetchData();
        fetchResults();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [fetchData, fetchResults]);

  // Fetch live scores every 30s
  const refreshScores = useCallback(async () => {
    const scores = await fetchLiveScores();
    setLiveGames(scores);
    setLastUpdated(new Date());
  }, []);

  useEffect(() => {
    refreshScores();
    const interval = setInterval(refreshScores, 30000);
    return () => clearInterval(interval);
  }, [refreshScores]);

  // Fetch box scores for ALL props with live/finished games (every 30s)
  useEffect(() => {
    if (!data?.props || !liveGames.length) return;

    const fetchStats = async () => {
      // Only consider games from today (prevents stale yesterday stats)
      const todayDate = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD
      const isToday = (g) => {
        if (!g.gameDate) return g.status === 'in'; // no date = only trust live games
        try { return new Date(g.gameDate).toLocaleDateString('en-CA') === todayDate; }
        catch { return false; }
      };

      // Find unique live/post games that have props AND are from today
      const gameMap = new Map();
      for (const prop of data.props) {
        const game = matchPropToGame(prop, liveGames);
        if (game && game.eventId && (game.status === 'in' || game.status === 'post') && isToday(game)) {
          const cfg = ESPN_SPORTS[game.league];
          if (cfg && !gameMap.has(game.eventId)) {
            gameMap.set(game.eventId, { sport: cfg.key, leagueKey: cfg.league, game });
          }
        }
      }

      if (!gameMap.size) return;

      // Fetch all box scores in parallel
      const boxScores = {};
      const entries = [...gameMap.entries()];
      const results = await Promise.all(entries.map(([eid, { sport, leagueKey }]) => fetchBoxScore(eid, sport, leagueKey)));
      entries.forEach(([eid], i) => { if (results[i]) boxScores[eid] = results[i]; });

      // Extract stats for ALL props
      const newStats = {};
      for (const prop of data.props) {
        const game = matchPropToGame(prop, liveGames);
        if (!game || !game.eventId || !boxScores[game.eventId]) continue;
        const result = findPlayerStat(prop.player, prop.market, boxScores[game.eventId]);
        if (result !== null) {
          const key = propKey(prop);
          newStats[key] = { current: result.current, gameStatus: game.status, period: game.period, clock: game.clock };
        }
      }
      setLiveStats(newStats);
    };

    fetchStats();
    const interval = setInterval(fetchStats, 30000);
    return () => clearInterval(interval);
  }, [data?.props, liveGames]);

  const liveCount = liveGames.filter(g => g.status === 'in').length;
  const closeCount = liveGames.filter(g => g.status === 'in' && g.isLate && Math.abs(g.awayScore - g.homeScore) <= 5).length;

  const betCount = myBets.size;
  const fadeCount = [...myBets.values()].filter(v => entryState(v) === 'fade').length;
  // Only show leagues that have real games today (hides off-season leagues like NFL in April)
  const todayDateISO = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD
  // Picks tab date picker: /api/data now returns today-through-next-week (soccer
  // locks picks in up to 7 days ahead for CLV — see ShadowB-Soccer). Filter down
  // to what the picker's asking for; each pick carries its own isoDate.
  const tmrwDateObj = new Date(); tmrwDateObj.setDate(tmrwDateObj.getDate() + 1);
  const tomorrowDateISO = tmrwDateObj.toLocaleDateString('en-CA');
  const weekAheadDateObj = new Date(); weekAheadDateObj.setDate(weekAheadDateObj.getDate() + 7);
  const weekAheadDateISO = weekAheadDateObj.toLocaleDateString('en-CA');
  const picksForTab = (data?.todayPicks || []).filter(p => {
    if (!p.isoDate) return picksDateFilter === 'Today'; // no date = assume today
    if (picksDateFilter === 'Today') return p.isoDate === todayDateISO;
    if (picksDateFilter === 'Tomorrow') return p.isoDate === tomorrowDateISO;
    // This Week: today through 7 days out, inclusive (includes tomorrow).
    return p.isoDate >= todayDateISO && p.isoDate <= weekAheadDateISO;
  });
  // Scores tab always shows only TODAY's games, independent of whatever the
  // Picks tab's date picker is set to — so it needs its own today-only slice
  // rather than the full today-through-next-week data (matching a future pick
  // to today's game by team name alone would be wrong).
  const todaysPicksOnly = (data?.todayPicks || []).filter(p => !p.isoDate || p.isoDate === todayDateISO);
  // Uncommitted count for the Picks tab badge — plays in today's slate with no
  // manual take/fade yet. Only meaningful pre-commit; watch mode means the
  // slate's already been triaged, so nothing to flag.
  const uncommittedCount = pickMode === 'build' ? dedup(todaysPicksOnly).filter(p => !isBet(p) && !isFade(p)).length : 0;
  const realGames = liveGames.filter(g => {
    if (g.status === 'in') return true; // live = real
    if (!g.gameDate) return false;
    try { return new Date(g.gameDate).toLocaleDateString('en-CA') === todayDateISO; }
    catch { return false; }
  });
  const activeLeagues = [...new Set(realGames.map(g => g.league))];
  const activeLeaguePills = ['NBA', 'NHL', 'MLB', 'NFL', 'EPL'].filter(l => activeLeagues.includes(l));
  // For picks/props, also include leagues from data even if no ESPN games yet
  const dataLeagues = data ? [...new Set([
    ...(data.todayPicks || []).map(p => p.league),
    ...(data.props || []).map(p => p.league),
  ])].filter(Boolean) : [];
  const allActiveLeagues = [...new Set([...activeLeaguePills, ...dataLeagues])].filter(l => ['NBA', 'NHL', 'MLB', 'NFL', 'EPL'].includes(l));

  // sf/sportPills now only drive the Props tab's league row — Picks, Scores,
  // and Results each manage their own league/My-Bets filter locally.
  const propBetCount = [...myBets.entries()].filter(([k]) => k.startsWith('prop|')).length;
  const sportPills = propBetCount > 0 ? ['All', 'My Bets', ...allActiveLeagues] : ['All', ...allActiveLeagues];

  // When switching tabs, drop a stale "My Bets" filter if Props has nothing to show for it
  const handleTabChange = (newTab) => {
    setTab(newTab);
    if (sf === 'My Bets' && newTab === 'props' && propBetCount === 0) setSf('All');
  };

  // Settings has no bottom-tab entry point right now (dropped per Nick's request —
  // may get a way back in later). The tab/route and SettingsTab component are
  // still here, just unreachable from the tab bar.
  const tabs = [
    { id: 'picks', label: 'Picks', icon: '/icons/sonic.png' },
    { id: 'scores', label: 'Scores', icon: '/icons/shadow.png' },
    { id: 'props', label: 'Props', icon: '/icons/knuckles.png' },
    { id: 'results', label: 'Results', icon: '/icons/tails.png' },
  ];

  // Picks/Scores/Results are self-contained tape screens with their own header,
  // slate strip, and league row (per the Direction A handoff) — App's legacy
  // chrome (title bar + Pills rows) now only wraps Props and Settings, which
  // weren't part of that redesign.
  const legacyChrome = tab === 'props';

  return (
    <div style={{ maxWidth: 480, margin: '0 auto', background: '#0A0B0D', minHeight: '100vh', position: 'relative' }}>
      {legacyChrome && (
        <>
          <div style={{ background: '#0A0B0D', padding: '12px 14px 6px', position: 'sticky', top: 0, zIndex: 20 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 17, fontWeight: 800, color: '#F1F5F9', letterSpacing: -0.5 }}>Shadow Bets</span>
                {liveCount > 0 && (
                  <span style={{ fontSize: 9, color: '#34D399', fontWeight: 600, background: 'rgba(52,211,153,0.15)', padding: '2px 7px', borderRadius: 10 }}>
                    {liveCount} LIVE
                  </span>
                )}
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: 11, color: '#94A3B8' }}>{new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</div>
                {lastUpdated && <div style={{ fontSize: 9, color: '#64748B' }}>Updated {lastUpdated.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</div>}
              </div>
            </div>
            <Pills items={sportPills} active={sf} onChange={setSf} color={TAB_ACCENTS.props.accent} />
            <Pills items={['Today', 'Tomorrow', 'All']} active={propDateFilter} onChange={setPropDateFilter} color={TAB_ACCENTS.props.accent} />
            {(() => {
              const books = data?.props ? ['All', ...new Set(data.props.map(p => p.book).filter(Boolean))] : ['All'];
              return <Pills items={books} active={pf} onChange={setPf} color={TAB_ACCENTS.props.accent} />;
            })()}
          </div>
          <div style={{ height: 3, background: TAB_ACCENTS.props.gradient, position: 'sticky', top: 'var(--header-height, 0)', zIndex: 19, animation: 'shimmer 2s ease-in-out infinite' }} />
        </>
      )}

      {/* Animations */}
      <style>{`
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.6; } }
        @keyframes shimmer { 0% { opacity: 0.7; } 50% { opacity: 1; } 100% { opacity: 0.7; } }
      `}</style>

      {/* Content */}
      <div style={{ padding: legacyChrome || tab === 'settings' ? '8px 12px 90px' : '0 0 90px' }}>
        {loading && <LoadingSkeleton />}
        {error && (
          <div className="tp">
            <div className="ah"><b>Shadow Bets</b><span style={{ color: 'var(--loss)' }}>LOAD FAILED</span></div>
            <div className="empty">
              Couldn't reach the model run.<br />
              <button className="abtn ghost" style={{ marginTop: 14 }} onClick={() => { setError(null); setLoading(true); fetchData(); }}>Retry</button>
            </div>
          </div>
        )}
        {data && tab === 'picks' && (
          <PicksTab
            picks={picksForTab} liveGames={liveGames} myBets={myBets} setMyBets={setMyBets}
            isBet={isBet} isFade={isFade} toggleBet={toggleBet} setPickState={setPickState} displayPick={displayPick}
            pickMode={pickMode} setPickMode={setPickMode} tierThreshold={tierThreshold} setTierThreshold={setTierThreshold}
            picksDateFilter={picksDateFilter} setPicksDateFilter={setPicksDateFilter}
            showDate={picksDateFilter === 'This Week'} lastUpdated={lastUpdated}
            commitSnapshot={commitSnapshot} committedCount={committedCount} committedUnits={committedUnits}
            undoLeft={undoLeft} commitTake={commitTake} undoCommit={undoCommit}
            stake={stake} sizing={sizing} setSizing={setSizing} sizingPresets={SIZING_PRESETS}
          />
        )}
        {data && tab === 'scores' && (
          <ScoresTab
            liveGames={liveGames.filter(g => {
              // Hide off-season games (e.g. Super Bowl replay in April)
              if (g.status === 'in') return true;
              if (!g.gameDate) return false;
              try { return new Date(g.gameDate).toLocaleDateString('en-CA') === todayDateISO; }
              catch { return false; }
            })}
            picks={todaysPicksOnly} isBet={isBet} isFade={isFade} displayPick={displayPick} lastUpdated={lastUpdated} stake={stake}
          />
        )}
        {data && tab === 'props' && <PropsTab props={data.props} todayGames={data.todayGames} sf={sf} pf={pf} propDateFilter={propDateFilter} isPropBet={isPropBet} isPropFade={isPropFade} toggleProp={toggleProp} liveStats={liveStats} myPropBets={getMyPropBets()} />}
        {data && tab === 'results' && resultType === 'Changelog' && (
          <div className="tp">
            <div className="ah"><b>Changelog</b><span className="clickable" onClick={() => setResultType('Games')}>BACK TO RESULTS</span></div>
            <div style={{ padding: '10px 14px' }}><ChangelogTab /></div>
          </div>
        )}
        {data && tab === 'results' && resultType !== 'Changelog' && (
          resultsData
            ? <ResultsTab results={resultsData.gradedPicks} gradedProps={resultsData.gradedProps || []} isBet={isBet} isPropBet={isPropBet} lastUpdated={lastUpdated} onChangelog={() => setResultType('Changelog')} />
            : resultsError
              ? (
                <div className="tp">
                  <div className="ah"><b>Results</b><span style={{ color: 'var(--loss)' }}>LOAD FAILED</span></div>
                  <div className="empty">
                    Couldn't load graded results.<br />
                    <button className="abtn ghost" style={{ marginTop: 14 }} onClick={fetchResults}>Retry</button>
                  </div>
                </div>
              )
              : <div className="tp"><div className="ah"><b>Results</b></div><div className="empty">Loading results…</div></div>
        )}
        {tab === 'settings' && <SettingsTab />}
      </div>

      {/* Tab Bar */}
      <div className="tp tabs" style={{
        position: 'fixed', bottom: 0, left: '50%', transform: 'translateX(-50%)',
        width: '100%', maxWidth: 480, gridTemplateColumns: 'repeat(4, 1fr)', zIndex: 30,
      }}>
        {tabs.map(t => (
          <button key={t.id} className={tab === t.id ? 'on' : ''} onClick={() => handleTabChange(t.id)} style={{ position: 'relative' }}>
            <img className="ti" src={t.icon} alt="" />
            <span className="tl">{t.label}</span>
            {t.id === 'scores' && closeCount > 0 && <span className="badge">{closeCount}</span>}
            {t.id === 'scores' && betCount > 0 && closeCount === 0 && <span className="badge" style={{ background: 'var(--take)', color: '#03142c' }}>{betCount}</span>}
            {t.id === 'picks' && uncommittedCount > 0 && <span className="badge">{uncommittedCount}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}
