import { readFileSync } from 'node:fs';
import init, { evaluate_general_octave } from '../web/src/wasm/iso9613_wasm.js';
await init(readFileSync(new URL('../web/src/wasm/iso9613_wasm_bg.wasm', import.meta.url)));
const NO_LAT = new Float64Array(0);
const AW=[-56.7,-39.4,-26.2,-16.1,-8.6,-3.2,0,1.2,1,-1.1];
const J=JSON.parse(readFileSync(new URL('./v2_calls.json',import.meta.url)));
const LW=new Float64Array(J.lw);
const G=0.5,tC=10,rh=70,p=101.325,barConv=1,dzCap=-1;
const ref={R1:6.9,R2:-8.9,R3:-0.8,R4:1.7,R5:15.6,R6:-2.6,R7:10,R8:8.6,R9:9.2,R10:13.8,R11:5.3,R12:15.8,R13:-5.9};
const old={R1:-16.26,R2:-9.96,R3:0.35,R4:-6.70,R5:6.82,R6:-4.21,R7:8.88,R8:-7.26,R9:-8.32,R10:13.02,R11:0.08,R12:-3.47,R13:-7.83};
function dba(pb){let s=0;for(let i=0;i<pb.length;i++)if(isFinite(pb[i]))s+=Math.pow(10,(pb[i]+AW[i])/10);return s>0?10*Math.log10(s):-Infinity;}
console.log('V2 (real DEM, 3 Megapacks, terrain virtual-barriers ON)\n');
console.log('Rx    ref    BEESTY(now)  diff(ref-now)   oldSheet   d(now-old)');
let sa=0,n=0;
for(const r of J.receivers){
  let energy=new Float64Array(10);
  for(const c of r.calls){
    const per=evaluate_general_octave(LW,c.se,c.sn,c.sZabs,c.sHagl,c.re,c.rn,c.rZabs,c.rHagl,G,new Float64Array(c.bars),tC,rh,p,barConv,dzCap,0,NO_LAT);
    for(let i=0;i<10;i++) if(isFinite(per[i])) energy[i]+=Math.pow(10,per[i]/10);
  }
  const pb=Array.from(energy,e=>e>0?10*Math.log10(e):-Infinity);
  const tot=dba(pb);
  const diff=ref[r.name]-tot; sa+=Math.abs(diff); n++;
  console.log(`${r.name.padEnd(4)} ${ref[r.name].toFixed(1).padStart(6)} ${tot.toFixed(2).padStart(11)} ${diff.toFixed(2).padStart(13)} ${old[r.name].toFixed(2).padStart(10)} ${(tot-old[r.name]).toFixed(2).padStart(11)}`);
}
console.log(`\nMean |ref - BEESTY(now)| = ${(sa/n).toFixed(2)} dB`);
