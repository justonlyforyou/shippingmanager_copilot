# Discovered Game Formulas

All formulas are from game files itself and verified against live game data as well.

---

## Harbor Fee (Total)

**Location:** `app.js` module 2576, function `ce` (exported as `l`)

```javascript
// Total harbor fee for cargo shipment
harborFee = (17000 / distance) * Math.pow(cargo, 1.2)
```

**Parameters:**
- `cargo` = actual cargo amount being transported (TEU)
- `distance` = route distance in nm

**With Perk Modifier:**
```javascript
if (userHasPerk("cheap_harbor_fees")) {
    harborFee = harborFee * ((100 - perkModifier) / 100)
}
```

**Verified Example:**
- Custom1Ship (cargo=1700 TEU, distance=5207 nm)
- Calculated: (17000 / 5207) * 1700^1.2 = $24,542
- Game showed: $24,569 (0.1% difference)

---

## Harbor Fee MIN/MAX (UI Display)

**Location:** `8182.js` line 1561, function `harborFees_minmax`

```javascript
// MIN: assumes cargo = 1 TEU
MIN = 17000 / distance

// MAX: assumes cargo = 27000 TEU (largest vessel in game)
MAX = (17000 / distance) * Math.pow(27000, 0.2)
    = (17000 / distance) * 7.697
```

**Verified Examples:**
| Vessel | Distance | Calculated MIN | Game MIN | Calculated MAX | Game MAX |
|--------|----------|----------------|----------|----------------|----------|
| NAVICOM | 933 nm | $18.22 | $18.22 | $140.27 | $140.23 |
| Custom1Ship | 5207 nm | $3.265 | $3.26 | $25.13 | $25.13 |

---

## Fuel Consumption

**Location:** `app.js` module 2576, function `a_` (exported as `o`)

```javascript
fuel = (capacity / 2000) * distance * Math.sqrt(speed) / 20 * fuel_factor
```

**Parameters:**
- `capacity` = vessel capacity (TEU). For tankers: capacity / 74
- `distance` = route distance in nm
- `speed` = vessel speed in knots
- `fuel_factor` = vessel-specific factor (from vessel data, default 1)

**With Perk Modifiers:**
```javascript
// travel_speed_increase perk affects speed
if (userHasPerk("travel_speed_increase")) {
    speed = Math.max(speed - perkModifier, 5)
}

// Fuel reduction perks stack
totalReduction = reduce_fuel_consumption.modifier + less_fuel_consumption.modifier
fuel = fuel * (1 - totalReduction / 100)
```

---

## Fuel Consumption Display (kg/nm @ speed)

**Derived Formula** for vessel panel display "Fuel cons/Xkn":

```javascript
// Simplified from main formula (fuel / distance)
fuel_kg_per_nm = capacity * Math.sqrt(speed) * fuel_factor / 40
```

**Verified Example:**
| Vessel | Capacity | Speed | fuel_factor | Calculated | Game Display |
|--------|----------|-------|-------------|------------|--------------|
| MV Ancylon | 480 TEU | 18 kn | ~1.079 | 54.94 kg/nm | 54.94 kg/nm |

**Note:** `fuel_factor` is vessel-specific and must be retrieved from API vessel data.
Without knowing fuel_factor, calculate the base value (fuel_factor=1) then derive:
```javascript
fuel_factor = game_display_value / (capacity * Math.sqrt(speed) / 40)
```

---

## CO2 Emission (per TEU/nm)

**Location:** `app.js` module 2576, function `G_` (exported as `i`)

```javascript
co2_per_teu_nm = (2 - capacity / 15000) * co2_factor
```

**Parameters:**
- `capacity` = vessel capacity (TEU). For tankers: capacity / 74
- `co2_factor` = vessel-specific factor (from vessel data, default 1)

**With Perk Modifier:**
```javascript
if (userHasPerk("reduce_co2_consumption")) {
    co2_factor = co2_factor * (1 - perkModifier / 100)
}
```

**Verified Example:**
| Vessel | Capacity | co2_factor | Calculated | Game Display |
|--------|----------|------------|------------|--------------|
| MV Ancylon | 480 TEU | 1 | 1.968 kg/TEU/nm | 1.97 kg/TEU/nm |

---

## Route Creation Fee

**Location:** `8182.js` line 1571, function `routeFee`

```javascript
routeFee = (40 * capacity + 10 * distance) * trainingMultiplier + drydockPrice
```

**Parameters:**
- `capacity` = sum of vessel capacity_max (dry + refrigerated). For tankers: divided by 74
- `distance` = route total_distance in nm
- `trainingMultiplier` = perk modifier from "cheap_route_creation_fee" (default: 1)
- `drydockPrice` = drydock maintenance price if drydock_on_arrival is true, otherwise 0

**Base Formula (no perks, no drydock):**
```javascript
routeFee = 40 * capacity + 10 * distance
```

**Verified Examples:**
| Vessel | Capacity | Distance | Calculated | Game |
|--------|----------|----------|------------|------|
| Atlantic Venture | 294 TEU | 1375 nm | 25,510 | 25,510 |
| NAVICOM | 250 TEU | 933 nm | 19,330 | 19,330 |
| Custom1Ship | 2000 TEU | 5207 nm | 132,070 | 132,070 |

---

## Travel Time

**Location:** `app.js` module 2576, function `gc` (exported as `a`)

```javascript
base_time = 600 + 6 * Math.min(200, distance)

if (distance <= 200) {
    time = base_time
} else {
    time = Math.floor(base_time + (distance - 200) / speed * 75)
}

// With 4x speed perk active:
if (speedBoostActive) {
    time = Math.floor(time / 4)
}
```

**Output:** Time in seconds

**Verified Examples:**
| Vessel | Distance | Speed | Calculated | Game |
|--------|----------|-------|------------|------|
| NAVICOM | 933 nm | 20 kn | 4548.75s (01:15:49) | 01:15:48 |
| Atlantic Venture | 1375 nm | 12 kn | 9143.75s (02:32:24) | 02:32:24 |

---

## Hijacking Risk

**Location:** `app.js` module 2576, function `qs` (exported as `s`)

```javascript
risk = Math.max(5, Math.min(35, Math.ceil(5.7 * (factor / speed) + speed / 1000)))
```

**Parameters:**
- `factor` = unknown factor (possibly distance or cargo value)
- `speed` = vessel speed in knots

**Output:** Risk percentage (5% - 35%)

---

## Delivery Price (Instant Delivery)

**Location:** `app.js` module 2576, function `zK` (exported as `c`)

```javascript
// Per vessel, based on time until arrival
pricePerVessel = Math.min(45, Math.ceil(secondsUntilArrival / 300))

// Total for multiple vessels
totalPrice = sum(pricePerVessel for each vessel)
```

**Output:** Price in points (max 45 per vessel, 5-minute increments)

---

## Guards Cost

**Location:** `8182.js` line 1188, 1589, 1624

```javascript
guardCost = 700  // Fixed cost per guard

totalGuardsFee = guards * guardCost

// With cheap_guards perk:
if (userHasPerk("cheap_guards")) {
    totalGuardsFee = totalGuardsFee * (100 - perkModifier) / 100
}
```

---

## Cubic Function (Unknown Purpose)

**Location:** `app.js` module 2576, function `pB` (exported as `u`)

```javascript
result = (value === 0) ? 0 : Math.pow(value, 3)
```

---

## Module 2576 Export Summary

| Export | Function | Purpose |
|--------|----------|---------|
| `a_` / `o` | Fuel Consumption | Calculate fuel usage |
| `G_` / `i` | CO2 Emission | Calculate CO2 per TEU/nm |
| `gc` / `a` | Travel Time | Calculate route duration |
| `qs` / `s` | Hijacking Risk | Calculate piracy risk % |
| `zK` / `c` | Delivery Price | Calculate instant delivery cost |
| `ce` / `l` | Harbor Fee | Calculate harbor fees |
| `pB` / `u` | Cubic | Unknown (value^3) |
| `R8` / `f` | Date Format | Format timestamps |
| `fP` / `p` | Relative Time | Format relative time |

---

## Perks Reference

| Perk ID | Effect |
|---------|--------|
| `cheap_harbor_fees` | Reduce harbor fees by X% |
| `cheap_guards` | Reduce guard costs by X% |
| `cheap_route_creation_fee` | Reduce route creation fee (multiplier) |
| `reduce_fuel_consumption` | Reduce fuel consumption by X% |
| `less_fuel_consumption` | Reduce fuel consumption by X% (stacks) |
| `reduce_co2_consumption` | Reduce CO2 emissions by X% |
| `travel_speed_increase` | Reduce effective speed for fuel calc |
| `speed` (4x boost) | Divide travel time by 4 |

---

*Last updated: 2025-11-22*
