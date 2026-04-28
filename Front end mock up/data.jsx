// Reference data for WTG / BESS dropdowns. (placeholder values — best-guess)

const WTG_MODELS = [
  { id:'v163', name:'Vestas V163-4.5 MW (placeholder)', hubHeights:[119,148,166], modes:['PO4500-0S','PO4500','SO1','SO2','SO3','SO11','SO12','SO13'], lwa:{ PO4500:106.5, 'PO4500-0S':108.0, SO1:104.5, SO2:103.0, SO3:101.5, SO11:100.0, SO12:99.0, SO13:98.0 } },
  { id:'v150', name:'Vestas V150-4.5 MW (placeholder)', hubHeights:[105,125,155,166], modes:['Mode 0','Mode 1','Mode 2','Mode 3'], lwa:{'Mode 0':107.0,'Mode 1':105.0,'Mode 2':103.0,'Mode 3':101.0} },
  { id:'ge158', name:'GE 6.1-158 (placeholder)',          hubHeights:[101,120,150,161], modes:['Std','NRO-1','NRO-3','NRO-5'], lwa:{Std:108.0,'NRO-1':107.0,'NRO-3':105.0,'NRO-5':103.0} },
  { id:'sg155', name:'Siemens Gamesa SG 5.0-155 (placeholder)', hubHeights:[102,127,140], modes:['Mode 0','Mode 1','Mode 2'], lwa:{'Mode 0':106.5,'Mode 1':104.0,'Mode 2':101.5} },
  { id:'n149', name:'Nordex N149/5.X (placeholder)',      hubHeights:[105,125,164], modes:['Mode 0','Mode 1','Mode 2','Mode 3'], lwa:{'Mode 0':105.5,'Mode 1':104.0,'Mode 2':102.0,'Mode 3':100.0} },
  { id:'gw175', name:'Goldwind GW175-6.0 (placeholder)',   hubHeights:[110,130,160], modes:['Mode 0','Mode 1','Mode 2'], lwa:{'Mode 0':107.0,'Mode 1':105.0,'Mode 2':102.5} },
];

const WIND_SPEEDS = [3,4,5,6,7,8,9,10,11,12]; // m/s @ 10m

const BESS_MODELS = [
  { id:'mp2xl',  name:'Tesla Megapack 2 XL (placeholder)', modes:['2-hr / 9-fan','4-hr / 5-fan','Idle / cooling'], lwa:{'2-hr / 9-fan':95.0,'4-hr / 5-fan':91.0,'Idle / cooling':82.0} },
  { id:'mp2',    name:'Tesla Megapack 2 (placeholder)',    modes:['Charging','Discharging','Idle'], lwa:{Charging:93.0,Discharging:92.0,Idle:80.0} },
  { id:'pwt',    name:'Sungrow PowerTitan 2.0 (placeholder)', modes:['Standard'], lwa:{Standard:94.0} },
  { id:'cs',     name:'CATL EnerC+ 4MWh (placeholder)',    modes:['Standard'], lwa:{Standard:93.5} },
  { id:'fluence',name:'Fluence Gridstack Pro (placeholder)', modes:['High','Eco'], lwa:{High:94.5,Eco:91.0} },
  { id:'wartsila',name:'Wartsila Quantum 2 (placeholder)', modes:['Standard'], lwa:{Standard:93.0} },
];

const PALETTES = {
  viridis: ['#440154','#3b528b','#21918c','#5ec962','#fde725'],
  magma:   ['#000004','#3b0f70','#8c2981','#de4968','#fcfdbf'],
  plasma:  ['#0d0887','#7e03a8','#cc4778','#f89441','#f0f921'],
  inferno: ['#000004','#420a68','#932667','#dd513a','#fcffa4'],
  rdylgn:  ['#1a9850','#a6d96a','#ffffbf','#fdae61','#d73027'],
  grey:    ['#f5f5f5','#cfcfcf','#9e9e9e','#5e5e5e','#1f1f1f'],
};

const CONTOUR_BANDS = [
  { lo:30, hi:35, label:'30 – 35 dB' },
  { lo:35, hi:40, label:'35 – 40 dB' },
  { lo:40, hi:45, label:'40 – 45 dB' },
  { lo:45, hi:50, label:'45 – 50 dB' },
  { lo:50, hi:99, label:'> 50 dB' },
];

// Sample placed sources around a flat-ish bit of land near Goyder, SA
const INITIAL_WTGS = [
  { id:'WTG-01', lat:-33.5910, lng:138.7320, modelId:'v163', hub:148, mode:'PO4500', windSpeed:8 },
  { id:'WTG-02', lat:-33.5945, lng:138.7390, modelId:'v163', hub:148, mode:'PO4500', windSpeed:8 },
  { id:'WTG-03', lat:-33.5980, lng:138.7460, modelId:'v163', hub:148, mode:'SO2',    windSpeed:8 },
  { id:'WTG-04', lat:-33.6015, lng:138.7530, modelId:'v163', hub:148, mode:'SO2',    windSpeed:8 },
  { id:'WTG-05', lat:-33.6050, lng:138.7600, modelId:'v163', hub:148, mode:'PO4500', windSpeed:8 },
  { id:'WTG-06', lat:-33.6085, lng:138.7670, modelId:'v163', hub:148, mode:'PO4500', windSpeed:8 },
  { id:'WTG-07', lat:-33.5870, lng:138.7250, modelId:'v150', hub:125, mode:'Mode 0', windSpeed:8 },
  { id:'WTG-08', lat:-33.5830, lng:138.7180, modelId:'v150', hub:125, mode:'Mode 0', windSpeed:8 },
];

const INITIAL_BESS = [
  { id:'BESS-A', lat:-33.5760, lng:138.7100, modelId:'mp2xl', mode:'2-hr / 9-fan', heading:35, count:24 },
  { id:'BESS-B', lat:-33.6120, lng:138.7780, modelId:'pwt',   mode:'Standard',     heading:120, count:16 },
];

const INITIAL_RECEIVERS = [
  { id:'R01', name:'Farmstead 12',   lat:-33.5680, lng:138.7050, level:38.4, limit:40 },
  { id:'R02', name:'Cottage Lane',   lat:-33.5750, lng:138.7530, level:42.1, limit:40 },
  { id:'R03', name:'Hill House',     lat:-33.6000, lng:138.6970, level:35.8, limit:40 },
  { id:'R04', name:'Smith Property', lat:-33.6180, lng:138.7600, level:39.7, limit:40 },
  { id:'R05', name:'School',         lat:-33.5860, lng:138.7700, level:41.5, limit:40 },
  { id:'R06', name:'Ridge View',     lat:-33.6230, lng:138.7290, level:33.2, limit:40 },
  { id:'R07', name:'Old Mill Rd',    lat:-33.5920, lng:138.6920, level:36.9, limit:40 },
  { id:'R08', name:'Lake House',     lat:-33.6100, lng:138.7900, level:37.4, limit:40 },
];

// Calculation area — rotated rectangle (4 lat/lng corners, drawn order)
const INITIAL_CALC_AREA = {
  centerLat:-33.5950, centerLng:138.7400,
  widthKm:9, heightKm:7, rotationDeg:18,
};

Object.assign(window, {
  WTG_MODELS, WIND_SPEEDS, BESS_MODELS, PALETTES, CONTOUR_BANDS,
  INITIAL_WTGS, INITIAL_BESS, INITIAL_RECEIVERS, INITIAL_CALC_AREA,
});
