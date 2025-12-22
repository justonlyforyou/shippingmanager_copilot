# 🚢 Shippingmanager.cc - Cheat Sheet / Glitch Guide

## ⚡ Faster Delivery Glitch

1. **Build** a new vessel. (Does not work with vessels you bought)
2. Go straight to **Maintenance > Dry Dock** and select your fresh ship.
3. Send it to the dry dock immediately.
4. Just ignore any weird behavior or visual bugs around the ship for a moment you mabe have ingame.
5. Check the **Pending Tab** (left side menu) and wait for the maintenance timer to hit zero.
6. **Done:** Once maintenance finishes, your ship "arrives" instantly (skipping the delivery travel time).
7. **Bonus:** You just doubled the time until the next required dry dock!
8. *Check the next bug below, you can combo these two.* 👇

## 🛠️ "Unlimited" time until next DryDock

1. Every new vessel spawns at a port that has a dry dock.
2. **CRITICAL:** Before you send your ship anywhere, throw it into the dry dock.
3. This glitches the timer: The "Time to next Dry Dock" gets added on top of the default value.
   * *Example:* Default is 350h > after first dry dock it's 700h > then 1050h, etc.
4. **Rinse and repeat:** You can do this as many times as you want. We haven't found a limit yet - as long as you have the in-game cash to pay for it! 💸

## 🔧 Building Vessels via Browser Console

Execute this directly in the browser console (F12) while logged into shippingmanager.cc.

**Pro tip:** You can build tankers even without having unlocked "Tanker Operations"! Since all tankers available for purchase are garbage anyway, you can save your achievement points and build your own custom tankers this way. And yes - this can be combined with the Fast Delivery Glitch above! 🎉

### Quick Start

```javascript
fetch('/api/vessel/build-vessel', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    name: 'My Vessel',
    ship_yard: 'antwerpen',
    vessel_model: 'container',
    engine_type: 'man_p22l',
    engine_kw: 12000,
    capacity: 10000,
    range: 9600,
    propeller_types: '5_blade_propeller',
    antifouling_model: 'type_a',
    bulbous: 1,
    enhanced_thrusters: 0
  })
}).then(r => r.json()).then(console.log);
```

### Parameters

| Parameter | Values |
|-----------|--------|
| `vessel_model` | `container` (2000-27000 TEU) or `tanker` (148000-1998000 BBL) |
| `engine_type` | `mih_x1`, `wartsila_syk_6`, `man_p22l`, `mih_xp9`, `man_p22l_z`, `mih_cp9` |
| `propeller_types` | `4_blade_propeller`, `5_blade_propeller`, `6_blade_propeller` |
| `antifouling_model` | `type_a`, `type_b`, or `null` |
| `bulbous` | `0` or `1` |
| `enhanced_thrusters` | `0` or `1` |

### Engine kW Ranges

| Engine | kW Range |
|--------|----------|
| `mih_x1` | 2500 - 11000 |
| `wartsila_syk_6` | 5000 - 15000 |
| `man_p22l` | 8000 - 17500 |
| `mih_xp9` | 10000 - 20000 |
| `man_p22l_z` | 15000 - 25000 |
| `mih_cp9` | 25000 - 60000 |

### Shipyards

| Code | Location |
|------|----------|
| `port_of_botany_sydney` | Australia, Port Of Botany Sydney |
| `freeport_container_port` | Bahamas, Freeport Container Port |
| `antwerpen` | Belgium, Antwerpen |
| `rio_de_janeiro` | Brazil, Rio De Janeiro |
| `varna` | Bulgaria, Varna |
| `shanghai` | China, Shanghai |
| `tianjin_xin_gang` | China, Tianjin Xin Gang |
| `port_said` | Egypt, Port Said |
| `port_of_le_havre` | France, Port Of Le Havre |
| `rade_de_brest` | France, Rade De Brest |
| `port_of_piraeus` | Greece, Port Of Piraeus |
| `genova` | Italy, Genova |
| `napoli` | Italy, Napoli |
| `porto_di_lido_venezia` | Italy, Porto Di Lido Venezia |
| `nagasaki` | Japan, Nagasaki |
| `osaka` | Japan, Osaka |
| `bayrut` | Lebanon, Bayrut |
| `johor` | Malaysia, Johor |
| `veracruz` | Mexico, Veracruz |
| `auckland` | New Zealand, Auckland |
| `gdansk` | Poland, Gdansk |
| `lisboa` | Portugal, Lisboa |
| `port_of_singapore` | Singapore, Port Of Singapore |
| `cape_town` | South Africa, Cape Town |
| `durban` | South Africa, Durban |
| `pusan` | South Korea, Pusan |
| `stockholm_norvik` | Sweden, Stockholm Norvik |
| `chi_lung` | Taiwan, Chi Lung |
| `belfast` | United Kingdom, Belfast |
| `southampton` | United Kingdom, Southampton |
| `baltimore` | United States, Baltimore |
| `boston_us` | United States, Boston |
| `mobile` | United States, Mobile |
| `oakland` | United States, Oakland |
| `philadelphia` | United States, Philadelphia |

### Formulas

```javascript
// Calculate range based on engine power and capacity
range = Math.min(18000, Math.ceil(8000 * engine_kw / capacity));

// Calculate speed based on engine power and capacity
speed = Math.max(5, Math.min(35, Math.ceil(5.7 * engine_kw / capacity + capacity / 1000)));
```

## 🗺️ Premium Map Themes (Free Unlock)

The premium map tiles are hosted without authentication. You can switch themes directly via browser console - no purchase required!

### Switch Map Theme

```javascript
// Available themes: 'dark', 'sky', 'street', 'satellite', 'city', 'light'
(function(theme) {
  const themes = {
    dark: 'am_dark',
    sky: 'am_sky',
    street: 'am_streets',
    satellite: 'satellite',
    city: 'am_city_1-10',
    light: 'shipping-map-4-2-5'
  };
  const newBase = `https://mapservice.trophycdn.com/services/${themes[theme]}/tiles`;

  // Replace existing tiles
  document.querySelectorAll('.leaflet-tile-pane img').forEach(img => {
    const match = img.src.match(/\/(\d+)\/(\d+)\/(\d+)\.png/);
    if (match) {
      img.src = `${newBase}/${match[1]}/${match[2]}/${match[3]}.png`;
    }
  });

  // Watch for new tiles (when panning/zooming)
  const observer = new MutationObserver(mutations => {
    mutations.forEach(m => {
      m.addedNodes.forEach(node => {
        if (node.tagName === 'IMG' && node.src.includes('tiles')) {
          const match = node.src.match(/\/(\d+)\/(\d+)\/(\d+)\.png/);
          if (match) {
            node.src = `${newBase}/${match[1]}/${match[2]}/${match[3]}.png`;
          }
        }
      });
    });
  });
  observer.observe(document.querySelector('.leaflet-tile-pane'), {childList: true, subtree: true});

  console.log('Switched to', theme, 'theme - observer active for new tiles');
})('dark');  // <-- Change theme here: dark, sky, street, satellite, city, light
```

### Quick Theme Switchers (One-Liners)

**Dark Mode:**
```javascript
(t=>{const b=`https://mapservice.trophycdn.com/services/am_dark/tiles`;document.querySelectorAll('.leaflet-tile-pane img').forEach(i=>{const m=i.src.match(/\/(\d+)\/(\d+)\/(\d+)\.png/);if(m)i.src=`${b}/${m[1]}/${m[2]}/${m[3]}.png`});new MutationObserver(ms=>ms.forEach(m=>m.addedNodes.forEach(n=>{if(n.tagName==='IMG'){const x=n.src.match(/\/(\d+)\/(\d+)\/(\d+)\.png/);if(x)n.src=`${b}/${x[1]}/${x[2]}/${x[3]}.png`}}))).observe(document.querySelector('.leaflet-tile-pane'),{childList:1,subtree:1})})()
```

**Sky Mode:**
```javascript
(t=>{const b=`https://mapservice.trophycdn.com/services/am_sky/tiles`;document.querySelectorAll('.leaflet-tile-pane img').forEach(i=>{const m=i.src.match(/\/(\d+)\/(\d+)\/(\d+)\.png/);if(m)i.src=`${b}/${m[1]}/${m[2]}/${m[3]}.png`});new MutationObserver(ms=>ms.forEach(m=>m.addedNodes.forEach(n=>{if(n.tagName==='IMG'){const x=n.src.match(/\/(\d+)\/(\d+)\/(\d+)\.png/);if(x)n.src=`${b}/${x[1]}/${x[2]}/${x[3]}.png`}}))).observe(document.querySelector('.leaflet-tile-pane'),{childList:1,subtree:1})})()
```

**Satellite Mode:**
```javascript
(t=>{const b=`https://mapservice.trophycdn.com/services/satellite/tiles`;document.querySelectorAll('.leaflet-tile-pane img').forEach(i=>{const m=i.src.match(/\/(\d+)\/(\d+)\/(\d+)\.png/);if(m)i.src=`${b}/${m[1]}/${m[2]}/${m[3]}.png`});new MutationObserver(ms=>ms.forEach(m=>m.addedNodes.forEach(n=>{if(n.tagName==='IMG'){const x=n.src.match(/\/(\d+)\/(\d+)\/(\d+)\.png/);if(x)n.src=`${b}/${x[1]}/${x[2]}/${x[3]}.png`}}))).observe(document.querySelector('.leaflet-tile-pane'),{childList:1,subtree:1})})()
```

**Street Mode:**
```javascript
(t=>{const b=`https://mapservice.trophycdn.com/services/am_streets/tiles`;document.querySelectorAll('.leaflet-tile-pane img').forEach(i=>{const m=i.src.match(/\/(\d+)\/(\d+)\/(\d+)\.png/);if(m)i.src=`${b}/${m[1]}/${m[2]}/${m[3]}.png`});new MutationObserver(ms=>ms.forEach(m=>m.addedNodes.forEach(n=>{if(n.tagName==='IMG'){const x=n.src.match(/\/(\d+)\/(\d+)\/(\d+)\.png/);if(x)n.src=`${b}/${x[1]}/${x[2]}/${x[3]}.png`}}))).observe(document.querySelector('.leaflet-tile-pane'),{childList:1,subtree:1})})()
```

**City Mode:**
```javascript
(t=>{const b=`https://mapservice.trophycdn.com/services/am_city_1-10/tiles`;document.querySelectorAll('.leaflet-tile-pane img').forEach(i=>{const m=i.src.match(/\/(\d+)\/(\d+)\/(\d+)\.png/);if(m)i.src=`${b}/${m[1]}/${m[2]}/${m[3]}.png`});new MutationObserver(ms=>ms.forEach(m=>m.addedNodes.forEach(n=>{if(n.tagName==='IMG'){const x=n.src.match(/\/(\d+)\/(\d+)\/(\d+)\.png/);if(x)n.src=`${b}/${x[1]}/${x[2]}/${x[3]}.png`}}))).observe(document.querySelector('.leaflet-tile-pane'),{childList:1,subtree:1})})()
```

### Available Free Tile URLs (Limited Zoom)

Note: Free tiles only work from zoom level 3+. Below that, tiles won't load.

| Theme | URL | Max Zoom |
|-------|-----|----------|
| Dark | `https://mapservice.trophycdn.com/services/am_dark/tiles/{z}/{x}/{y}.png` | 9 |
| Sky | `https://mapservice.trophycdn.com/services/am_sky/tiles/{z}/{x}/{y}.png` | 7 |
| Street | `https://mapservice.trophycdn.com/services/am_streets/tiles/{z}/{x}/{y}.png` | 8 |
| Satellite | `https://mapservice.trophycdn.com/services/satellite/tiles/{z}/{x}/{y}.png` | 8 |
| City | `https://mapservice.trophycdn.com/services/am_city_1-10/tiles/{z}/{x}/{y}.png` | 10 |
| Light | `https://mapservice.trophycdn.com/services/shipping-map-4-2-5/tiles/{z}/{x}/{y}.png` | 5 |

## Premium MapBox Tiles (Full Zoom)

The game uses MapBox premium tiles with a secret token that's exposed in the frontend code. These tiles support full zoom (0-22) and higher quality.

### MapBox Access Token

```javascript
// Token from game's JavaScript (Module 6392)
const MAPBOX_TOKEN = 'sk.eyJ1Ijoic2hqb3J0aCIsImEiOiJjbGV0cHdodGwxaWZnM3NydnlvNHc4cG02In0.D5n6nIFb0JqhGA9lM_jRkw';
```

### Switch to Premium MapBox Tiles

```javascript
// Available themes: 'light', 'dark', 'streets', 'satellite', 'city', 'sky'
(function(theme) {
  const TOKEN = 'sk.eyJ1Ijoic2hqb3J0aCIsImEiOiJjbGV0cHdodGwxaWZnM3NydnlvNHc4cG02In0.D5n6nIFb0JqhGA9lM_jRkw';
  const themes = {
    light: 'mapbox/light-v10',
    dark: 'mapbox/dark-v10',
    streets: 'mapbox/streets-v11',
    satellite: 'mapbox/satellite-v9',
    city: 'shjorth/ck6hrwoqh0uuy1iqvq5jmcch2',
    sky: 'shjorth/ck6hzf3qq11wg1ijsrtfaouxb'
  };

  const isCustom = theme === 'city' || theme === 'sky';
  const newBase = isCustom
    ? `https://api.mapbox.com/styles/v1/${themes[theme]}/tiles/256`
    : `https://api.mapbox.com/styles/v1/${themes[theme]}/tiles`;
  const suffix = isCustom ? '@2x' : '';

  // Replace existing tiles
  document.querySelectorAll('.leaflet-tile-pane img').forEach(img => {
    const match = img.src.match(/\/(\d+)\/(\d+)\/(\d+)/);
    if (match) {
      img.src = `${newBase}/${match[1]}/${match[2]}/${match[3]}${suffix}?access_token=${TOKEN}`;
    }
  });

  // Watch for new tiles (when panning/zooming)
  const observer = new MutationObserver(mutations => {
    mutations.forEach(m => {
      m.addedNodes.forEach(node => {
        if (node.tagName === 'IMG') {
          const match = node.src.match(/\/(\d+)\/(\d+)\/(\d+)/);
          if (match) {
            node.src = `${newBase}/${match[1]}/${match[2]}/${match[3]}${suffix}?access_token=${TOKEN}`;
          }
        }
      });
    });
  });
  observer.observe(document.querySelector('.leaflet-tile-pane'), {childList: true, subtree: true});

  // Unlock max zoom (MapBox supports up to 22)
  try {
    const app = document.querySelector('#app').__vue_app__;
    const pinia = app._context.provides.pinia || app.config.globalProperties.$pinia;
    const map = pinia._s.get('mapStore').map;
    map.setMaxZoom(18);
    console.log('Switched to MapBox', theme, '- Max zoom: 18');
  } catch(e) {
    console.log('Switched to MapBox', theme, '- zoom unlock failed:', e.message);
  }
})('dark');  // <-- Change theme here: light, dark, streets, satellite, city, sky
```

### Quick Premium Theme Switchers (One-Liners)

**MapBox Dark (Full Zoom):**
```javascript
(t=>{const T='sk.eyJ1Ijoic2hqb3J0aCIsImEiOiJjbGV0cHdodGwxaWZnM3NydnlvNHc4cG02In0.D5n6nIFb0JqhGA9lM_jRkw',b='https://api.mapbox.com/styles/v1/mapbox/dark-v10/tiles';document.querySelectorAll('.leaflet-tile-pane img').forEach(i=>{const m=i.src.match(/\/(\d+)\/(\d+)\/(\d+)/);if(m)i.src=`${b}/${m[1]}/${m[2]}/${m[3]}?access_token=${T}`});new MutationObserver(ms=>ms.forEach(m=>m.addedNodes.forEach(n=>{if(n.tagName==='IMG'){const x=n.src.match(/\/(\d+)\/(\d+)\/(\d+)/);if(x)n.src=`${b}/${x[1]}/${x[2]}/${x[3]}?access_token=${T}`}}))).observe(document.querySelector('.leaflet-tile-pane'),{childList:1,subtree:1});try{const p=document.querySelector('#app').__vue_app__._context.provides.pinia;p._s.get('mapStore').map.setMaxZoom(18)}catch(e){}})()
```

**MapBox Satellite (Full Zoom):**
```javascript
(t=>{const T='sk.eyJ1Ijoic2hqb3J0aCIsImEiOiJjbGV0cHdodGwxaWZnM3NydnlvNHc4cG02In0.D5n6nIFb0JqhGA9lM_jRkw',b='https://api.mapbox.com/styles/v1/mapbox/satellite-v9/tiles';document.querySelectorAll('.leaflet-tile-pane img').forEach(i=>{const m=i.src.match(/\/(\d+)\/(\d+)\/(\d+)/);if(m)i.src=`${b}/${m[1]}/${m[2]}/${m[3]}?access_token=${T}`});new MutationObserver(ms=>ms.forEach(m=>m.addedNodes.forEach(n=>{if(n.tagName==='IMG'){const x=n.src.match(/\/(\d+)\/(\d+)\/(\d+)/);if(x)n.src=`${b}/${x[1]}/${x[2]}/${x[3]}?access_token=${T}`}}))).observe(document.querySelector('.leaflet-tile-pane'),{childList:1,subtree:1});try{const p=document.querySelector('#app').__vue_app__._context.provides.pinia;p._s.get('mapStore').map.setMaxZoom(18)}catch(e){}})()
```

**MapBox Streets (Full Zoom):**
```javascript
(t=>{const T='sk.eyJ1Ijoic2hqb3J0aCIsImEiOiJjbGV0cHdodGwxaWZnM3NydnlvNHc4cG02In0.D5n6nIFb0JqhGA9lM_jRkw',b='https://api.mapbox.com/styles/v1/mapbox/streets-v11/tiles';document.querySelectorAll('.leaflet-tile-pane img').forEach(i=>{const m=i.src.match(/\/(\d+)\/(\d+)\/(\d+)/);if(m)i.src=`${b}/${m[1]}/${m[2]}/${m[3]}?access_token=${T}`});new MutationObserver(ms=>ms.forEach(m=>m.addedNodes.forEach(n=>{if(n.tagName==='IMG'){const x=n.src.match(/\/(\d+)\/(\d+)\/(\d+)/);if(x)n.src=`${b}/${x[1]}/${x[2]}/${x[3]}?access_token=${T}`}}))).observe(document.querySelector('.leaflet-tile-pane'),{childList:1,subtree:1});try{const p=document.querySelector('#app').__vue_app__._context.provides.pinia;p._s.get('mapStore').map.setMaxZoom(18)}catch(e){}})()
```

### Premium MapBox Tile URLs

| Theme | URL |
|-------|-----|
| Light | `https://api.mapbox.com/styles/v1/mapbox/light-v10/tiles/{z}/{x}/{y}?access_token=TOKEN` |
| Dark | `https://api.mapbox.com/styles/v1/mapbox/dark-v10/tiles/{z}/{x}/{y}?access_token=TOKEN` |
| Streets | `https://api.mapbox.com/styles/v1/mapbox/streets-v11/tiles/{z}/{x}/{y}?access_token=TOKEN` |
| Satellite | `https://api.mapbox.com/styles/v1/mapbox/satellite-v9/tiles/{z}/{x}/{y}?access_token=TOKEN` |
| City | `https://api.mapbox.com/styles/v1/shjorth/ck6hrwoqh0uuy1iqvq5jmcch2/tiles/256/{z}/{x}/{y}@2x?access_token=TOKEN` |
| Sky | `https://api.mapbox.com/styles/v1/shjorth/ck6hzf3qq11wg1ijsrtfaouxb/tiles/256/{z}/{x}/{y}@2x?access_token=TOKEN` |

## VIP Vessels (Direct Purchase)

The game has hidden VIP vessels that aren't shown in the shop UI but can be purchased directly via API if you know their vessel ID. Prices range from 2,500 to 8,000 anchor points. All come with +50% cargo revenue boost.

### Known VIP Vessels (Complete List)

| ID | Name | Type | Capacity | Spawn Port | Image | Price |
|----|------|------|----------|------------|-------|-------|
| 59 | Starliner | Container | 28,000 TEU | Mina Jabal Ali | VIP_Red.jpg | 2,500 pts |
| 60 | MS Sundown | Tanker | 2,072,000 BBL | New York City | VIP_Oil.jpg | 3,500 pts |
| 61 | MS Anaconda | Container | 28,000 TEU | Shanghai | VIP_Blue.jpg | 4,500 pts |
| 62 | Big Bear | Container | 28,000 TEU | Oslo | VIP_Yellow.jpg | 6,000 pts |
| 63 | Ventura | Container | 28,000 TEU | Tokyo | VIP_Green.jpg | 8,000 pts |

**Note:** IDs 53-58 were tested and return `no_vessel_found`. The VIP range is 59-63 only.

### VIP Vessel Specs (All Identical)

| Property | Value |
|----------|-------|
| Engine | MIH X1 |
| Power | 60,000 kW |
| Max Speed | 40 kn |
| Range | 17,400-17,500 nm |
| Drydock Interval | 250 hours |
| CO2 Factor | 1.0 |
| Fuel Factor | 1.0 |
| Delivery Time | 48 hours (172,800s) |
| Year | 2023 |
| Gearless | No |

### VIP Perk

```json
"perks": {
  "moreLoad": 50
}
```

**Effect:** +50% cargo revenue on all deliveries. This is the only perk VIP vessels have.

### Purchase VIP Vessel via Browser Console

Execute this in the browser console (F12) while logged into shippingmanager.cc:

```javascript
// Purchase a hidden VIP vessel by ID
// Change the vessel_id to the one you want (59, 60, 61, 62, etc.)
fetch('/api/vessel/purchase-vessel', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ vessel_id: 60 })  // <-- Change ID here
}).then(r => r.json()).then(data => {
  if (data.data?.vessel) {
    console.log('SUCCESS! Purchased:', data.data.vessel.name);
    console.log('Vessel details:', data.data.vessel);
  } else {
    console.log('Failed:', data);
  }
});
```

### Test/Preview VIP Vessel (Without Purchasing)

Use this script to check vessel details before buying:

```javascript
// Preview vessel info without purchasing
async function previewVessel(id) {
  console.log(`Checking vessel_id: ${id}...`);
  try {
    const res = await fetch('/api/vessel/show-acquirable-vessel', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({vessel_id: id})
    });
    const data = await res.json();
    if (data.data?.vessels_for_sale) {
      console.log(`FOUND! ID ${id}:`, data.data.vessels_for_sale.name);
      console.log(data.data.vessels_for_sale);
      return data.data.vessels_for_sale;
    } else {
      console.log(`ID ${id}: No vessel found`);
      return null;
    }
  } catch(e) {
    console.log(`ID ${id}: Error`, e);
    return null;
  }
}

// Quick test functions - just type: preview59(), preview60(), etc.
const preview59 = () => previewVessel(59);  // Starliner (2,500 pts)
const preview60 = () => previewVessel(60);  // MS Sundown (3,500 pts)
const preview61 = () => previewVessel(61);  // MS Anaconda (4,500 pts)
const preview62 = () => previewVessel(62);  // Big Bear (6,000 pts)
const preview63 = () => previewVessel(63);  // Ventura (8,000 pts)

console.log('Ready! Preview vessels with: preview59(), preview60(), preview61(), preview62(), preview63()');
```

### Quick Purchase One-Liners

**Buy Starliner (Container, ID 59) - 2,500 pts:**
```javascript
fetch('/api/vessel/purchase-vessel',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({vessel_id:59})}).then(r=>r.json()).then(d=>console.log(d.data?.vessel?.name||'Failed',d))
```

**Buy MS Sundown (Tanker, ID 60) - 3,500 pts:**
```javascript
fetch('/api/vessel/purchase-vessel',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({vessel_id:60})}).then(r=>r.json()).then(d=>console.log(d.data?.vessel?.name||'Failed',d))
```

**Buy MS Anaconda (Container, ID 61) - 4,500 pts:**
```javascript
fetch('/api/vessel/purchase-vessel',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({vessel_id:61})}).then(r=>r.json()).then(d=>console.log(d.data?.vessel?.name||'Failed',d))
```

**Buy Big Bear (Container, ID 62) - 6,000 pts:**
```javascript
fetch('/api/vessel/purchase-vessel',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({vessel_id:62})}).then(r=>r.json()).then(d=>console.log(d.data?.vessel?.name||'Failed',d))
```

**Buy Ventura (Container, ID 63) - 8,000 pts:**
```javascript
fetch('/api/vessel/purchase-vessel',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({vessel_id:63})}).then(r=>r.json()).then(d=>console.log(d.data?.vessel?.name||'Failed',d))
```

## Race Condition Exploit (Buy Without Enough Points)

There's a timing bug in the purchase API that allows you to buy a VIP vessel even if you don't have enough anchor points. By firing many purchase requests simultaneously, one request can slip through before the server validates your point balance.

### How It Works

1. The server has a lock (`already_posting_purchase_vessel`) to prevent duplicate purchases
2. But the point balance check happens AFTER the lock is acquired
3. If you fire enough simultaneous requests, one can complete the purchase before the balance is validated
4. Result: You get the vessel but your points go NEGATIVE

### Warning

- **No guarantee!** This is a timing-based race condition - success depends on server load and luck
- **You will go into negative points!** Example: 2,132 pts - 8,000 pts = -5,868 pts
- **You cannot buy anything else** until you earn enough points to get back to positive
- Only works if you currently have POSITIVE points (even if not enough for the vessel)

### Browser Console Script

Execute this in the browser console (F12) while logged into shippingmanager.cc:

```javascript
// Race Condition Purchase - fires 100 simultaneous requests
// Change vessel_id to the VIP vessel you want (59-63)
(async function raceConditionBuy(vesselId = 63, numRequests = 100) {
  console.log(`Starting race condition attack on vessel ID ${vesselId} with ${numRequests} requests...`);

  const promises = [];
  for (let i = 0; i < numRequests; i++) {
    promises.push(
      fetch('/api/vessel/purchase-vessel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vessel_id: vesselId })
      }).then(r => r.json()).catch(e => ({ error: e.message }))
    );
  }

  const results = await Promise.all(promises);

  const successes = results.filter(r => r.data?.vessel?.name);
  const errors = {};
  results.forEach(r => {
    const err = r.error || 'unknown';
    errors[err] = (errors[err] || 0) + 1;
  });

  console.log('='.repeat(50));
  console.log('RESULTS:');
  console.log(`Successes: ${successes.length}`);
  successes.forEach(s => console.log(`  GOT: ${s.data.vessel.name} (Points: ${s.user?.points})`));
  console.log('Errors:', errors);

  if (successes.length > 0) {
    console.log(`>>> SUCCESS! Got ${successes.length} vessel(s)! <<<`);
    console.log(`Your points are now: ${successes[0].user?.points} (probably negative)`);
  } else {
    console.log('No luck this time. Try again or increase numRequests.');
  }

  return successes;
})();
```

### Quick One-Liner (100 requests for Ventura)

```javascript
(async(id=63,n=100)=>{const r=await Promise.all([...Array(n)].map(()=>fetch('/api/vessel/purchase-vessel',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({vessel_id:id})}).then(r=>r.json()).catch(e=>({error:e}))));const s=r.filter(x=>x.data?.vessel);console.log(`Success: ${s.length}/${n}`,s[0]?.data?.vessel?.name||'None',`Points: ${s[0]?.user?.points||r[0]?.user?.points}`);return s})()
```

## Race Condition: Build Multiple Vessels with just having money for one

The `vessel/build-vessel` endpoint has the same race condition vulnerability as VIP purchases. By firing multiple simultaneous build requests, you can construct several identical vessels while only paying once.

### How It Works

1. The server checks cash balance AFTER acquiring a build lock
2. Multiple simultaneous requests can slip through before the first transaction commits
3. Result: You get multiple vessels but cash only deducted once (goes negative)

### Warning - Think Before You Exploit!

**This might NOT be the smartest idea!**

- **Cash goes MASSIVELY NEGATIVE!** We went from +$32M to -$58M in one exploit
- **You can't buy fuel anymore!** Ships sitting in port = no income = stuck forever without selling or other dirty tricks. This is for people earning enough with a full bunker to turn this into something helpfull ;)
- **You can't depart vessels!** No fuel = no departures = game basically broken
- **Recovery takes FOREVER!** You need to earn back tens of millions before you can play normally again
- Works best with 6-10 simultaneous requests
- All ships get the SAME name (server doesn't validate uniqueness fast enough)
- Mix of Steam/Browser requests increases success rate

**Bottom line:** Yes, you get free ships. But if you can't fuel them, what's the point? Only use this if you have a recovery plan or don't care about the account!

### Browser Console Script

```javascript
// Race Condition Build - fires simultaneous build requests
// Adjust config for your desired ship
(async function raceConditionBuild(numRequests = 6) {
  const suffix = Math.random().toString(36).substring(2, 6).toUpperCase();

  const config = {
    name: `RaceShip${suffix}`,
    ship_yard: 'baltimore',        // Must have drydock!
    vessel_model: 'container',
    engine_type: 'mih_x1',
    engine_kw: 11000,
    capacity: 2000,
    antifouling_model: 'type_a',
    bulbous: 1,
    enhanced_thrusters: 0,
    range: 18000,
    propeller_types: '6_blade_propeller'
  };

  console.log(`Building ${numRequests}x "${config.name}" simultaneously...`);
  console.log(`Ship cost: ~$30M | Your cash: check before running!`);

  const promises = [];
  for (let i = 0; i < numRequests; i++) {
    promises.push(
      fetch('/api/vessel/build-vessel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config)
      }).then(r => r.json()).catch(e => ({ error: e.message }))
    );
  }

  const results = await Promise.all(promises);

  const successes = results.filter(r => r.data?.success);
  const errors = {};
  results.forEach(r => {
    const err = r.error || 'success';
    errors[err] = (errors[err] || 0) + 1;
  });

  console.log('='.repeat(50));
  console.log('RESULTS:');
  console.log(`Ships built: ${successes.length}/${numRequests}`);
  console.log(`Cash after: $${successes[0]?.user?.cash?.toLocaleString() || results[0]?.user?.cash?.toLocaleString()}`);
  console.log('Breakdown:', errors);

  if (successes.length > 1) {
    console.log(`>>> RACE CONDITION SUCCESS! Built ${successes.length} ships! <<<`);
  }

  return successes;
})();
```

### Quick One-Liner (6 requests)

```javascript
(async(n=6)=>{const c={name:'Race'+Math.random().toString(36).slice(2,6).toUpperCase(),ship_yard:'baltimore',vessel_model:'container',engine_type:'mih_x1',engine_kw:11000,capacity:2000,antifouling_model:'type_a',bulbous:1,enhanced_thrusters:0,range:18000,propeller_types:'6_blade_propeller'};const r=await Promise.all([...Array(n)].map(()=>fetch('/api/vessel/build-vessel',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(c)}).then(r=>r.json()).catch(e=>({error:e}))));const s=r.filter(x=>x.data?.success);console.log(`Built: ${s.length}/${n}`,`Cash: $${(s[0]||r[0])?.user?.cash?.toLocaleString()}`);return s})()
```

