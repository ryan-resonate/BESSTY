import { readFileSync } from 'node:fs';
import init, { evaluate_general_octave } from '../web/src/wasm/beesty_solver.js';
await init(readFileSync(new URL('../web/src/wasm/beesty_solver_bg.wasm', import.meta.url)));
const AW=[-56.7,-39.4,-26.2,-16.1,-8.6,-3.2,0,1.2,1,-1.1];
const F=[16,31.5,63,125,250,500,1000,2000,4000,8000];
const LW=[0,0,0,65,78,89,90,88,84,74];
const G=0.5,tC=10,rh=70,p=101.325,barConv=1,dzCap=-1;
// Port of ISO 9613-1 alpha (dB/km), ISO ref atmosphere
function alpha(f){const T=tC+273.15,t0=293.15,t01=273.16,P=p*1000,pr=101325,hr=rh;
 const psat=Math.pow(10,-6.8346*Math.pow(t01/T,1.261)+4.6151);const h=hr*psat*(pr/P);
 const frO=(P/pr)*(24+4.04e4*h*(0.02+h)/(0.391+h));
 const frN=(P/pr)*Math.pow(T/t0,-0.5)*(9+280*h*Math.exp(-4.170*(Math.pow(T/t0,-1/3)-1)));
 const f2=f*f;const a=8.686*f2*(1.84e-11*(pr/P)*Math.sqrt(T/t0)+Math.pow(T/t0,-2.5)*(0.01275*Math.exp(-2239.1/T)/(frO+f2/frO)+0.1068*Math.exp(-3352/T)/(frN+f2/frN)));
 return a*1000;}
const dbaTot=pb=>{let s=0;for(let i=0;i<10;i++)if(isFinite(pb[i]))s+=Math.pow(10,(pb[i]+AW[i])/10);return s>0?10*Math.log10(s):-Infinity;};

console.log('=== V1 distance-attenuation decomposition (flat, 1 source) ===');
const src=[114701.20922794551,5795238.319364499];
const RXV1=[['R1',114902.37439463979,5795688.929337895],['R8',106944.28040021425,5785759.416709865]];
for(const [nm,x,y] of RXV1){
  const e=x-src[0],n=y-src[1],d=Math.hypot(e,n);
  const adiv=20*Math.log10(d)+11;
  const per=evaluate_general_octave(new Float64Array(LW),0,0,1.5,1.5,e,n,1.5,1.5,G,new Float64Array(0),tC,rh,p,barConv,dzCap);
  // reconstruct Agr per band = Lw - Adiv - Aatm - Lp(full)
  console.log(`\n ${nm}: d=${d.toFixed(0)} m  Adiv=${adiv.toFixed(2)} dB`);
  console.log('  band   Lw   Aatm   Lp(full)   implied Agr(=Lw-Adiv-Aatm-Lp)');
  for(let i=2;i<10;i++){const aatm=alpha(F[i])*d/1000;const agr=LW[i]-adiv-aatm-per[i];
    console.log(`  ${String(F[i]).padStart(5)} ${String(LW[i]).padStart(4)} ${aatm.toFixed(2).padStart(7)} ${per[i].toFixed(2).padStart(9)} ${agr.toFixed(2).padStart(9)}`);}
  console.log(`  -> total ${dbaTot(per).toFixed(2)} dB(A)`);
}

console.log('\n=== V2 terrain shielding isolation (with vs without DEM barriers) ===');
const J=JSON.parse(readFileSync(new URL('./v2_calls.json',import.meta.url)));
const ref={R1:6.9,R2:-8.9,R3:-0.8,R4:1.7,R5:15.6,R6:-2.6,R7:10,R8:8.6,R9:9.2,R10:13.8,R11:5.3,R12:15.8,R13:-5.9};
console.log('Rx    noBarrier  withBarrier  shielding   SoundPlan  (ref-with)');
for(const r of J.receivers){
  const eN=new Float64Array(10), eB=new Float64Array(10);
  for(const c of r.calls){
    const noB=evaluate_general_octave(new Float64Array(LW),c.se,c.sn,c.sZabs,c.sHagl,c.re,c.rn,c.rZabs,c.rHagl,G,new Float64Array(0),tC,rh,p,barConv,dzCap);
    const wB =evaluate_general_octave(new Float64Array(LW),c.se,c.sn,c.sZabs,c.sHagl,c.re,c.rn,c.rZabs,c.rHagl,G,new Float64Array(c.bars),tC,rh,p,barConv,dzCap);
    for(let i=0;i<10;i++){if(isFinite(noB[i]))eN[i]+=Math.pow(10,noB[i]/10);if(isFinite(wB[i]))eB[i]+=Math.pow(10,wB[i]/10);}
  }
  const pbN=Array.from(eN,e=>e>0?10*Math.log10(e):-Infinity), pbB=Array.from(eB,e=>e>0?10*Math.log10(e):-Infinity);
  const tN=dbaTot(pbN), tB=dbaTot(pbB);
  console.log(`${r.name.padEnd(4)} ${tN.toFixed(2).padStart(9)} ${tB.toFixed(2).padStart(12)} ${(tN-tB).toFixed(2).padStart(10)} ${ref[r.name].toFixed(1).padStart(10)} ${(ref[r.name]-tB).toFixed(2).padStart(10)}`);
}
