import { readFileSync } from 'node:fs';
import init, { evaluate_general_octave } from '../web/src/wasm/beesty_solver.js';
await init(readFileSync(new URL('../web/src/wasm/beesty_solver_bg.wasm', import.meta.url)));
const AW=[-56.7,-39.4,-26.2,-16.1,-8.6,-3.2,0,1.2,1,-1.1];
const LW=new Float64Array([0,0,0,65,78,89,90,88,84,74]);
const G=0.5,tC=10,rh=70,p=101.325,barConv=1,dzCap=-1;
const ref={R1:6.9,R2:-8.9,R3:-0.8,R4:1.7,R5:15.6,R6:-2.6,R7:10,R8:8.6,R9:9.2,R10:13.8,R11:5.3,R12:15.8,R13:-5.9};
const dba=pb=>{let s=0;for(let i=0;i<10;i++)if(isFinite(pb[i]))s+=Math.pow(10,(pb[i]+AW[i])/10);return s>0?10*Math.log10(s):-Infinity;};
function total(rec){const e=new Float64Array(10);for(const c of rec.calls){const per=evaluate_general_octave(LW,c.se,c.sn,c.sZabs,c.sHagl,c.re,c.rn,c.rZabs,c.rHagl,G,new Float64Array(c.bars),tC,rh,p,barConv,dzCap);for(let i=0;i<10;i++)if(isFinite(per[i]))e[i]+=Math.pow(10,per[i]/10);}return dba(Array.from(e,x=>x>0?10*Math.log10(x):-Infinity));}
console.log('samples |  mean|err|  max|err|  R4(BEESTY)  (R4 ref=1.7)');
for(const S of [12,24,48,96]){
  const J=JSON.parse(readFileSync(new URL(`./v2_s${S}.json`,import.meta.url)));
  let sa=0,mx=0,r4=0;
  for(const r of J.receivers){const t=total(r);const e=Math.abs(ref[r.name]-t);sa+=e;mx=Math.max(mx,e);if(r.name==='R4')r4=t;}
  console.log(`${String(S).padStart(7)} | ${(sa/13).toFixed(2).padStart(9)} ${mx.toFixed(2).padStart(9)} ${r4.toFixed(2).padStart(11)}`);
}
