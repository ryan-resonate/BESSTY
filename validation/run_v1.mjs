import { readFileSync } from 'node:fs';
import init, { evaluate_general_octave } from '../web/src/wasm/iso9613_wasm.js';
await init(readFileSync(new URL('../web/src/wasm/iso9613_wasm_bg.wasm', import.meta.url)));

const AW = [-56.7,-39.4,-26.2,-16.1,-8.6,-3.2,0,1.2,1,-1.1];
const LW = [0,0,0,65,78,89,90,88,84,74];
const src = [114701.20922794551, 5795238.319364499];
const RX = [
  ['R1',114902.37439463979,5795688.929337895],
  ['R2',115723.12827475242,5794554.357797739],
  ['R3',113421.79876776993,5793725.557310959],
  ['R4',112214.80776760427,5796316.5646579815],
  ['R5',114982.8404613175,5797925.885991535],
  ['R6',121001.70224881021,5796477.496791337],
  ['R7',120301.6474687141,5789573.508270389],
  ['R8',106944.28040021425,5785759.416709865],
];
const ref     = [28,17.1,10.3,5.4,5.4,-11.9,-17.2,-29.3];
const oldBeesty=[27.64042,16.45801,9.505059,4.379237,4.371488,-13.5632,-19.1375,-31.5359];

const G=0.5, tC=10, rh=70, p=101.325, barConv=1, dzCap=-1, H=1.5, ground=0;
function dba(perBand){ let s=0; for(let i=0;i<perBand.length;i++){ if(isFinite(perBand[i])) s+=Math.pow(10,(perBand[i]+AW[i])/10);} return s>0?10*Math.log10(s):-Infinity;}

console.log('V1 (flat DEM, single Megapack, Lw=94.1 dBA)\n');
console.log('Rx   dist(m)   ref     BEESTY(now)  diff(ref-now)   oldSheet   d(now-old)');
let sumAbs=0, n=0;
RX.forEach(([name,x,y],i)=>{
  const e=x-src[0], nn=y-src[1];
  const d=Math.hypot(e,nn);
  const per=evaluate_general_octave(new Float64Array(LW),0,0,ground+H,H,e,nn,ground+H,H,G,new Float64Array(0),tC,rh,p,barConv,dzCap,0,new Float64Array(0));
  const tot=dba(per);
  const diff=ref[i]-tot;
  sumAbs+=Math.abs(diff); n++;
  console.log(`${name.padEnd(4)} ${d.toFixed(0).padStart(7)} ${ref[i].toFixed(1).padStart(7)} ${tot.toFixed(2).padStart(11)} ${diff.toFixed(2).padStart(13)} ${oldBeesty[i].toFixed(2).padStart(11)} ${(tot-oldBeesty[i]).toFixed(2).padStart(11)}`);
});
console.log(`\nMean |ref - BEESTY(now)| = ${(sumAbs/n).toFixed(2)} dB`);
