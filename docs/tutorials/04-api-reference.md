# Shipping Manager API Reference

Keep a weather eye open, mateys: This here map was forged by pickin' apart the loot and may hide errors or sea monsters lurkin' in the deep.

Furthermore, hear ye this warnin': Sailin' the API tides without the official vessel likely breaks the Articles (ToS). Ye sail strictly at yer own peril! If the Governor catches ye, ye might be made to walk the plank and be banned from the game forever!

Mark ye well - these answers have been scrubbed clean and act as false flags. They don't reflect reality for reasons best kept silent. A savvy sailor will understand why! ;)

---

## Authentication & User Management

### Login
**Endpoint**: `POST /api/auth/login`

**Request**:
```json
{
  "token": "d91237c8f-fufu-4243-baba-a631b80a1234"
}
```

**Response**: `auth-login.json`

---

### Set Language
**Endpoint**: `POST /api/user/set-language`

**Request**:
```json
{
  "language": "en-GB"
}
```

**Response**: `user-set-language.json`

**Notes**: Supported languages: en-GB, de-DE, es-ES, fr-FR, pt-BR, etc.

---

### Get User Settings
**Endpoint**: `POST /api/user/get-user-settings`

**Request**:
```json
{}
```

**Response**: `user-get-user-settings.json`

**Returns**: User profile, preferences, tutorial status, difficulty mode, home port

---

### Get Company Info
**Endpoint**: `POST /api/user/get-company`

**Request**:
```json
{
  "user_id": 1234567
}
```

**Response**: `user-get-company.json`

**Returns**: Company name, registration date, statistics

---

### Get Weekly Transactions
**Endpoint**: `POST /api/user/get-weekly-transactions`

**Request**:
```json
{}
```

**Response**: `user-get-weekly-transactions.json`

**Returns**: Income, expenses, profit/loss for the past 7 days

---

### Search Users
**Endpoint**: `POST /api/user/search`

**Request**:
```json
{
  "name": "foo"
}
```

**Response**: `user-search.json`

**Returns**: List of users matching the search term (partial company name match)

**Use Cases**:
- Searching for players by company name
- Adding contacts or sending private messages
- Returns all matching users (can be slow with common search terms)
- Response includes both search results and current user data

---

## Game State

### Game Index (Main State)
**Endpoint**: `POST /api/game/index`

**Request**:
```json
{}
```

**Response**: `game-index.json`

**Returns**: Complete game state including:
- User data (cash, fuel, CO2, points)
- All vessels with current status
- Routes and demands
- Staff information
- Settings

**This is the most important endpoint - it returns the full game state**

---

## Vessels

### Get Vessel History
**Endpoint**: `POST /api/vessel/get-vessel-history`

**Request**:
```json
{
  "vessel_id": 87654321
}
```

**Response**: `vessel-get-vessel-history.json`

**Returns**: **Complete trip history** for a specific vessel including:
- `vessel_history`: Array of all completed trips with:
  - `route_origin` / `route_destination`: Ports traveled
  - `route_name`: Route identifier
  - `total_distance`: Distance in km
  - **`fuel_used`**: Actual fuel consumed in kg (CRITICAL)
  - **`route_income`**: Actual income earned in $ (CRITICAL)
  - `wear`: Wear accumulated on this trip
  - `cargo.dry` / `cargo.refrigerated`: Actual cargo carried
  - `duration`: Trip duration in seconds
  - `created_at`: Timestamp of trip completion

**Use Cases**:
- Calculate actual profit per trip (income - fuel_cost - co2_cost)
- Calculate fuel efficiency (km per ton)
- Calculate ROI (total profit / purchase price)
- Identify most profitable routes
- Track vessel performance over time
- **THIS IS THE GOLDMINE FOR VESSEL EFFICIENCY CALCULATIONS**

**Example Calculations**:
```javascript
// Profit per trip
const fuel_cost = (fuel_used / 1000) * fuel_price_per_ton;
const co2_cost = (fuel_used * 12.8 / 1000) * co2_price_per_ton;
const profit = route_income - fuel_cost - co2_cost;

// Fuel efficiency
const fuel_efficiency = total_distance / (fuel_used / 1000);  // km/ton

// Profit per hour
const duration_hours = duration / 3600;
const profit_per_hour = profit / duration_hours;
```

---

### Get Specific Vessels
**Endpoint**: `POST /api/vessel/get-vessels`

**Request**:
```json
{
  "vessel_ids": [87654321, 98765432, 12341234]
}
```

**Response**: `vessel-get-vessels.json`

**Returns**: Detailed information for specified vessels

---

### Get All User Vessels
**Endpoint**: `POST /api/vessel/get-all-user-vessels`

**Request**:
```json
{
  "include_routes": false
}
```

**Response**: `vessel-get-all-user-vessels.json`

**Returns**: All vessels owned by user. Set `include_routes: true` to include route details.

---

### Get All Acquirable Vessels
**Endpoint**: `POST /api/vessel/get-all-acquirable-vessels`

**Request**:
```json
{}
```

**Response**: `vessel-get-all-acquirable-vessels.json`

**Returns**: All vessels available for purchase from the shipyard

---

### Show Acquirable Vessel Details
**Endpoint**: `POST /api/vessel/show-acquirable-vessel`

**Request**:
```json
{
  "vessel_id": 59
}
```

**Response**: `vessel-show-acquirable-vessel.json`

**Returns**: Detailed specs, purchase price, delivery time for a specific vessel type

---

### Purchase Vessel
**Endpoint**: `POST /api/vessel/purchase-vessel`

**Request**:
```json
{
  "vessel_id": 59,
  "amount": 1
}
```

**Response**: `vessel-purchase-vessel.json`

**Returns**: Success/failure, new vessel IDs, cost

**Notes**:
- **DESTRUCTIVE ACTION** - Deducts cash from user balance
- Vessels enter "pending" status with delivery time
- Can purchase multiple vessels at once with `amount` parameter

---

### Get Vessel Sell Price
**Endpoint**: `POST /api/vessel/get-sell-price`

**Request**:
```json
{
  "vessel_id": 87654321
}
```

**Response**:
```json
{
  "selling_price": 1204000,
  "original_price": 1720000
}
```

**Returns**: Selling price and original purchase price for a user-owned vessel

**Notes**:
- `selling_price`: Amount the user will receive when selling the vessel
- `original_price`: Original purchase price of the vessel
- Selling price is typically lower than original price (depreciation)
- Only works for vessels owned by the user

---

### Sell Vessel
**Endpoint**: `POST /api/vessel/sell-vessel`

**Request**:
```json
{
  "vessel_id": 87654321
}
```

**Response**:
```json
{
  "success": true,
  "vessel": {
    "sell_price": 1204000
  }
}
```

**Returns**: Success confirmation and sell price of the sold vessel

**Notes**:
- Permanently removes vessel from user's fleet
- Cash is added to user balance immediately
- Vessel must be idle (not on route, not in maintenance)
- Cannot be undone - vessel is permanently sold

---

### Rename Vessel
**Endpoint**: `POST /api/vessel/rename-vessel`

**Request**:
```json
{
  "vessel_id": 87654321,
  "name": "Pacific Explorer"
}
```

**Parameters**:
- `vessel_id`: ID of the vessel to rename
- `name`: New vessel name (2-30 characters)

**Response**:
```json
{
  "success": true
}
```

**Returns**: Success confirmation after vessel is renamed

**Notes**:
- Name must be between 2-30 characters
- Special characters and HTML are sanitized
- Name change is immediate and reflected across all UI
- No cost to rename vessels

---

### Park Vessel
**Endpoint**: `POST /api/vessel/park-vessel`

**Request**:
```json
{
  "vessel_id": 87654321
}
```

**Parameters**:
- `vessel_id`: ID of the vessel to park (moor)

**Response**:
```json
{
  "success": true
}
```

**Returns**: Success confirmation after vessel is parked

**Notes**:
- Parks (moors) a vessel, taking it out of active service
- Parked vessels do not consume bunker or require maintenance
- Vessel must be idle (not on route, not in maintenance)
- Can be resumed later using `/vessel/resume-parked-vessel`

---

### Resume Parked Vessel
**Endpoint**: `POST /api/vessel/resume-parked-vessel`

**Request**:
```json
{
  "vessel_id": 87654321
}
```

**Parameters**:
- `vessel_id`: ID of the parked vessel to resume

**Response**:
```json
{
  "success": true
}
```

**Returns**: Success confirmation after vessel is resumed

**Notes**:
- Unmoores a parked vessel, putting it back into active service
- Vessel can then be assigned routes and departed
- Vessel returns to idle status after resuming

---

### Deliver Vessels (Instant Delivery)
**Endpoint**: `POST /api/vessel/deliver-vessels`

**Request**:
```json
{
  "vessel_ids": "[87654321]"
}
```

**Response**: FIXME

**Returns**: Success/failure, or error if insufficient points

**Notes**:
- **Costs premium currency (points)**: Each vessel has a `delivery_price` (typically 5 points)
- Instantly delivers pending vessels without waiting for delivery time
- `vessel_ids` must be a JSON string (not array)
- Returns `{"error": "not_enough_points", "user": {...}}` if insufficient points
- Only works for vessels with `status: "pending"`

---

### Build Custom Vessel
**Endpoint**: `POST /api/vessel/build-vessel`

**Request**:
```json
{
  "name": "Pacific Explorer",
  "ship_yard": "Timbucto",
  "vessel_model": "tanker",
  "engine_type": "diesel",
  "engine_kw": 15000,
  "capacity": 50000,
  "antifouling_model": "premium",
  "bulbous": 1,
  "enhanced_thrusters": 1,
  "range": 8500,
  "speed": 18.5,
  "fuel_consumption": 45,
  "propeller_types": "high_efficiency",
  "hull_color": "#2C3E50",
  "deck_color": "#ECF0F1",
  "bridge_color": "#FFFFFF",
  "container_color_1": "#E74C3C",
  "container_color_2": "#3498DB",
  "container_color_3": "#2ECC71",
  "container_color_4": "#F39C12",
  "name_color": "#FFFFFF",
  "custom_image": ""
}
```

**Parameters**:
- `name`: Vessel name (2-30 characters)
- `ship_yard`: Port code where vessel will be built
- `vessel_model`: Vessel type ("container", "tanker", "bulker", etc.)
- `engine_type`: Engine type ("diesel", "lng", "electric", etc.)
- `engine_kw`: Engine power in kilowatts
- `capacity`: Cargo capacity in TEU/tons
- `antifouling_model`: Antifouling coating type
- `bulbous`: Bulbous bow (0 or 1)
- `enhanced_thrusters`: Enhanced thrusters (0 or 1)
- `range`: Maximum range in km
- `speed`: Maximum speed in knots
- `fuel_consumption`: Fuel consumption per hour
- `propeller_types`: Propeller configuration
- `hull_color`: Hull color (hex code)
- `deck_color`: Deck color (hex code)
- `bridge_color`: Bridge color (hex code)
- `container_color_1-4`: Container colors (hex codes)
- `name_color`: Name text color (hex code)
- `custom_image`: Custom vessel image (base64 or URL)

**Response**:
```json
{
  "success": true,
  "vessel_id": 87654321,
  "cost": 5000000,
  "delivery_time": 7200
}
```

**Returns**: Success confirmation with vessel ID, cost, and delivery time

**Notes**:
- Builds a custom vessel with specified components and appearance
- Cost varies based on engine, capacity, and upgrades
- Vessel enters "pending" status with delivery time
- Can use premium currency to instant-deliver after building
- All color fields use hex color codes (e.g., "#FF0000" for red)
- This is a DESTRUCTIVE action that spends money

---

## Vessel Events

### Check Vessel Event
**Endpoint**: `POST /api/vessel-event/check`

**Request**:
```json
{
  "vessel_id": 87654321
}
```

**Parameters**:
- `vessel_id`: ID of the vessel to check for events

**Response**:
```json
{
  "data": {
    "event": null
  },
  "user": {}
}
```

**Returns**: Current event status for the vessel (if any)

**Notes**:
- Used to check if a vessel has an active event (hijacking, breakdown, etc.)
- Returns `null` event if no active event
- Called periodically by the game client to check vessel status

---

## Routes

### Get Vessel Ports
**Endpoint**: `POST /api/route/get-vessel-ports`

**Request**:
```json
{
  "user_vessel_id": 87654321
}
```

**Response**: `route-get-vessel-ports.json`

**Returns**: All ports that this specific vessel can travel to (based on vessel range/type)

---

### Get Routes Between Ports
**Endpoint**: `POST /api/route/get-routes-by-ports`

**Request**:
```json
{
  "port1": "hamburg",
  "port2": "new_york"
}
```

**Response**: `route-get-routes-by-ports.json`

**Returns**: Available routes between two ports, including distance, travel time, demand

---

### Get Suggested Route
**Endpoint**: `POST /api/route/get-suggested-route`

**Request**:
```json
{
  "user_vessel_id": 87654321
}
```

**Response**: `route-get-suggested-route.json`

**Returns**: AI-suggested optimal route for this vessel

---

### Create/Assign Route
**Endpoint**: `POST /api/route/create-user-route`

**Request**:
```json
{
  "route_id": 12345,
  "user_vessel_id": 87654321,
  "speed": 6,
  "guards": 0,
  "dry_operation": 0,
  "price_dry": 655,
  "price_refrigerated": 655
}
```

**Response**: `route-create-user-route.json` (NOT auto-fetched - requires careful setup)

**Returns**: Success/failure of route assignment

**Notes**:
- `speed`: 1-10 (affects fuel consumption and travel time)
- `guards`: Number of security guards (0-5, reduces piracy risk)
- `dry_operation`: 0 or 1 (whether vessel operates in dry mode)
- Prices are per TEU (Twenty-foot Equivalent Unit)

---

### Depart Vessel on Route
**Endpoint**: `POST /api/route/depart`

**Request**:
```json
{
  "user_vessel_id": 87654321,
  "speed": 8,
  "guards": 2,
  "history": 0
}
```

**Response**: `route-depart.json`

**Returns**:
```json
{
  "success": true
}
```

**Returns**: Success confirmation after vessel departs

**Notes**:
- Vessel must have an assigned route before departure
- Higher speed increases fuel consumption but reduces travel time
- Guards consume additional resources but reduce hijacking risk

---

### Depart Vessel on COOP Route
**Endpoint**: `POST /api/route/depart-coop`

**Request**:
```json
{
  "user_id": 1234567,
  "vessels": [
    {
      "vessel_id": 87654321,
      "speed": 8,
      "guards": 2
    },
    {
      "vessel_id": 12345678,
      "speed": 7,
      "guards": 1
    }
  ]
}
```

**Response**: `route-depart-coop.json`

**Returns**:
```json
{
  "success": true,
  "departed": 2
}
```

**Returns**: Success confirmation with count of departed vessels

**Notes**:
- Used for cooperative play routes with alliance members
- Multiple vessels can depart simultaneously
- COOP routes share revenue and contribution points with alliance
- Vessels must be eligible for COOP routes

---

### Depart All Ready Vessels
**Endpoint**: `POST /api/route/depart-all`

**Request**:
```json
{}
```

**Response**: `route-depart-all.json`

**Returns**: Count of successfully departed vessels

**Notes**:
- Departs all vessels that are ready and have routes assigned
- No parameters needed - automatically finds all eligible vessels
- Used by the game's "Depart All" button
- Vessels without assigned routes are skipped

---

### Get Auto-Calculated Route Pricing
**Endpoint**: `POST /api/route/auto-price`

**Request**:
```json
{
  "route_id": 12345
}
```

**Parameters**:
- `route_id`: ID of the route to get pricing suggestions for

**Response**:
```json
{
  "success": true,
  "price_dry": 655,
  "price_refrigerated": 720
}
```

**Returns**: AI-calculated optimal pricing for dry and refrigerated containers

**Notes**:
- Provides pricing suggestions based on demand and market conditions
- Helps optimize revenue per TEU (Twenty-foot Equivalent Unit)
- Separate pricing for dry and refrigerated cargo
- Prices are recommendations, can be adjusted when creating route

---

## Ports

### Get Port Information
**Endpoint**: `POST /api/port/get-ports`

**Request**:
```json
{
  "port_code": ["hamburg", "new_york"]
}
```

**Response**: `port-get-ports.json`

**Returns**: Detailed port information (coordinates, fees, facilities)

---

### Get Assigned Ports
**Endpoint**: `POST /api/port/get-assigned-ports`

**Request**:
```json
{}
```

**Response**: `port-get-assigned-ports.json`

**Returns**: List of ports assigned to the user based on alliance benefits and special unlocks

**Notes**: These ports may have reduced fees or special bonuses

---

### Get Alliance Data for Port
**Endpoint**: `POST /api/port/get-alliance-data`

**Request**:
```json
{
  "port_code": "murmansk"
}
```

**Response**: `port-get-alliance-data.json`

**Returns**: Alliance statistics for a specific port

**Response Structure**:
```json
{
  "data": {
    "top_alliances": [
      {
        "alliance_id": 1234,
        "alliance_name": "Example Alliance",
        "total_departures": 5432,
        "rank": 1
      }
    ],
    "my_alliance": {
      "alliance_id": 5678,
      "alliance_name": "My Alliance",
      "total_departures": 321,
      "rank": 15
    }
  }
}
```

**Notes**:
- Returns top 3 alliances by total departures from this port
- Includes user's own alliance rank if in an alliance
- Returns empty response if port has no alliance data (instead of 404)

**Use Cases**:
- Display port competition/rankings
- Show alliance dominance at specific ports
- Track alliance performance by port

---

## Demand & Pricing

### Auto-Price Route
**Endpoint**: `POST /api/demand/auto-price`

**Request**:
```json
{
  "user_vessel_id": 87654321,
  "route_id": 12345
}
```

**Response**: `demand-auto-price.json` (NOT auto-fetched)

**Returns**: AI-calculated optimal pricing for this route based on current demand

---

## Maintenance & Repair

### Get Maintenance Status
**Endpoint**: `POST /api/maintenance/get`

**Request**:
```json
{
  "vessel_ids": "[87654321, 87653421]"
}
```

**Response**: `maintenance-get.json`

**Returns**: Maintenance status, wear levels, repair costs for specified vessels

**Notes**: vessel_ids is a JSON string (not array)

---

### Get Maintenance Log
**Endpoint**: `POST /api/maintenance/get-log`

**Request**:
```json
{}
```

**Response**: `maintenance-get-log.json`

**Returns**: History of all maintenance performed

---

### Bulk Drydock Maintenance
**Endpoint**: `POST /api/maintenance/do-major-drydock-maintenance-bulk`

**Request**:
```json
{
  "vessel_ids": "[87653421,12345678]",
  "speed_factor": "maximum"
}
```

**Response**: `maintenance-do-major-drydock-maintenance-bulk.json`

**Returns**: Success/failure, total cost

**Notes**:
- **DESTRUCTIVE ACTION** - Spends money immediately
- `speed_factor`: "maximum" or "normal" (affects repair time and cost)

---

### Bulk Wear Maintenance
**Endpoint**: `POST /api/maintenance/do-wear-maintenance-bulk`

**Request**:
```json
{
  "vessel_ids": "[87653421,12345678]"
}
```

**Parameters**:
- `vessel_ids`: JSON string containing array of vessel IDs to repair

**Response**:
```json
{
  "success": true,
  "total_cost": 125000
}
```

**Returns**: Success confirmation with total repair cost

**Notes**:
- Repairs wear damage on multiple vessels in one operation
- More efficient than repairing vessels individually
- `vessel_ids` must be a JSON string, not a raw array
- This is a DESTRUCTIVE action that spends money immediately
- Vessels must be idle (not on route)

---

### Upgrade Vessel
**Endpoint**: `POST /api/maintenance/upgrade-vessel`

**Request**:
```json
{
  "vessel_id": 18429537,
  "antifouling_model": "type_a",
  "bulbous": 1
}
```

**Parameters**:
- `vessel_id`: The vessel ID to upgrade (required)
- `antifouling_model`: `"type_a"`, `"type_b"`, or `"type_c"` (optional) - Antifouling coating type
- `bulbous`: `1` to add bulbous bow, `0` or omit to skip (optional)

**Response**: `upgrade-vessel.json`

**Returns**: Updated vessel data with upgrades applied

**Notes**:
- **DESTRUCTIVE ACTION** - Spends money immediately
- Vessel must be parked (`is_parked: true`) to perform upgrades
- Upgrades trigger a maintenance period (`status` changes to `"maintenance"`)
- `maintenance_start_time` and `maintenance_end_time` indicate the maintenance window
- After upgrade: `antifouling` field shows the model, `bulbous_bow` becomes `true`
- Antifouling types affect fuel efficiency (type_a < type_b < type_c)
- Bulbous bow reduces fuel consumption

---

## Bunker (Fuel & CO2)

### Get Bunker Prices
**Endpoint**: `POST /api/bunker/get-prices`

**Request**:
```json
{}
```

**Response**: `bunker-get-prices.json`

**Returns**: Current fuel and CO2 prices per ton

---

### Purchase Fuel
**Endpoint**: `POST /api/bunker/purchase-fuel`

**Request**:
```json
{
  "amount": 2107
}
```

**Response**: `bunker-purchase-fuel.json`

**Returns**: Success/failure, amount purchased, cost

**Notes**:
- **DESTRUCTIVE ACTION** - Deducts cash from user balance
- Amount is in tons

---

### Purchase CO2
**Endpoint**: `POST /api/bunker/purchase-co2`

**Request**:
```json
{
  "amount": 1194
}
```

**Response**: `bunker-purchase-co2.json`

**Returns**: Success/failure, amount purchased, cost

**Notes**:
- **DESTRUCTIVE ACTION** - Deducts cash from user balance
- Amount is in tons

---

## Staff Management

### Get User Staff
**Endpoint**: `POST /api/staff/get-user-staff`

**Request**:
```json
{}
```

**Response**: `staff-get-user-staff.json`

**Returns**: All staff members, salaries, satisfaction levels

---

### Raise Staff Salary
**Endpoint**: `POST /api/staff/raise-salary`

**Request**:
```json
{
  "type": "cfo"
}
```

**Response**: `staff-raise-salary.json`

**Returns**: New salary, satisfaction change

**Notes**:
- **DESTRUCTIVE ACTION** - Increases ongoing salary costs
- Staff types: ceo, cfo, cto, sales, etc.

---

### Reduce Staff Salary
**Endpoint**: `POST /api/staff/reduce-salary`

**Request**:
```json
{
  "type": "cfo"
}
```

**Response**: `staff-reduce-salary.json`

**Returns**: New salary, satisfaction change

**Notes**:
- **DESTRUCTIVE ACTION** - Decreases staff satisfaction
- May lead to staff quitting if satisfaction too low

---

### Spend Training Point
**Endpoint**: `POST /api/staff/spend-training-point`

**Request**:
```json
{
  "type": "cfo",
  "perk_type": "cheap_anchor_points"
}
```

**Response**: `staff-spend-training-point.json`

**Returns**: Updated staff data with new perk level, perk modifiers, and remaining training points

**Notes**:
- Staff types: cfo, coo, cmo, cto, captain, first_officer, boatswain, technical_officer
- Use `perk_type` (string name), NOT `perk_type_id` (number)

**All Available Perk Types**:

CFO Perks:
- `shop_cash` - Increases cash received from shop (max level 20)
- `lower_channel_fees` - Reduces channel fees (max level 20)
- `cheap_anchor_points` - Reduces anchor point costs (max level 20)
- `cheap_fuel` - Reduces fuel costs (max level 20, requires shop_cash level 15)
- `cheap_co2` - Reduces CO2 costs (max level 20, requires shop_cash level 15)
- `cheap_harbor_fees` - Reduces harbor fees (max level 20, requires shop_cash level 20)
- `cheap_route_creation_fee` - Reduces route creation fees (max level 20, requires cheap_anchor_points level 5)

COO Perks:
- `happier_staff` - Increases staff happiness (max level 20)
- `less_crew` - Reduces crew requirements (max level 20, requires happier_staff level 5)
- `improved_staff_negotiations` - Improves staff salary negotiations (max level 6, requires happier_staff level 10)
- `lower_hijacking_chance` - Reduces hijacking probability (max level 20)
- `cheap_guards` - Reduces guard costs (max level 20, requires lower_hijacking_chance level 5)

CMO Perks:
- `higher_demand` - Increases cargo demand (max level 20, requires user level 20)
- `cheap_marketing` - Reduces marketing costs (max level 20)

CTO Perks:
- `reduce_co2_consumption` - Reduces CO2 consumption (max level 20)
- `reduce_fuel_consumption` - Reduces fuel consumption (max level 20, requires reduce_co2_consumption level 5)
- `travel_speed_increase` - Increases vessel speed (max level 3, requires reduce_fuel_consumption level 3)
- `slower_wear` - Reduces vessel wear rate (max level 20)
- `cheaper_maintenance` - Reduces maintenance costs (max level 20)

Captain Perks:
- `lower_crew_unhappiness` - Reduces crew unhappiness (max level 5, requires user level 12)

First Officer Perks:
- `less_crew_needed` - Reduces crew needed per vessel (max level 5, requires user level 8)

Boatswain Perks:
- `slower_wear_boatswain` - Reduces vessel wear rate (max level 5)

Technical Officer Perks:
- `less_fuel_consumption` - Reduces fuel consumption (max level 5)

---

## Contacts & Social

### Get Contacts
**Endpoint**: `POST /api/contact/get-contacts`

**Request**:
```json
{}
```

**Response**: `contact-get-contacts.json`

**Returns**: Contact list including:
- `contacts`: Direct contacts added by user
- `alliance_contacts`: Members of user's alliance

**Notes**: Used for private messaging and social features

---

## Messenger (Private Messages)

### Get Chats
**Endpoint**: `POST /api/messenger/get-chats`

**Request**:
```json
{}
```

**Response**: `messenger-get-chats.json`

**Returns**: List of all message threads including:
- Private conversations with other players
- System messages (hijacking notifications, stock trades, etc.)
- Each chat includes subject, last message, timestamp, participants

**Notes**:
- System chats have `system_chat: true` flag
- Hijacking messages include `case_id` for ransom negotiations
- Messages array is empty (use separate endpoint to get full thread)

---

### Send Private Message
**Endpoint**: `POST /api/messenger/send-message`

**Request**:
```json
{
  "recipient": 1234567,
  "subject": "Trade Discussion",
  "body": "Hello, I'm interested in discussing a potential partnership."
}
```

**Parameters**:
- `recipient`: User ID of the message recipient
- `subject`: Message subject line (required)
- `body`: Message content (required)

**Response**:
```json
{
  "success": true
}
```

**Returns**: Success confirmation after message is sent

**Notes**:
- Both subject and body are required fields
- Message appears immediately in recipient's messenger
- Used for player-to-player communication

---

### Get Chat Messages
**Endpoint**: `POST /api/messenger/get-chat`

**Request**:
```json
{
  "chat_id": 12345
}
```

**Response**: `messenger-get-chat.json`

**Returns**:
```json
{
  "messages": [
    {
      "id": 67890,
      "sender_id": 1234567,
      "body": "Message content here",
      "created_at": "2025-11-25 10:30:00"
    }
  ]
}
```

**Returns**: Array of messages in the chat thread

**Notes**:
- Use `/messenger/get-chats` (plural) to get list of all chats first
- Then use this endpoint to get messages for a specific chat
- Messages are returned in chronological order

---

### Mark Chat as Read
**Endpoint**: `POST /api/messenger/mark-as-read`

**Request**:
```json
{
  "chat_ids": "[12345,12346]",
  "system_message_ids": "[]"
}
```

**Parameters**:
- `chat_ids`: JSON string of regular chat IDs to mark as read
- `system_message_ids`: JSON string of system message IDs to mark as read

**Response**:
```json
{
  "success": true
}
```

**Returns**: Success confirmation after marking chats as read

**Notes**:
- Both parameters are required (use "[]" for empty)
- Regular chats: player-to-player messages
- System messages: hijacking notifications, stock trades, etc.
- Clears "unread" badge from marked chats

---

### Delete Chat
**Endpoint**: `POST /api/messenger/delete-chat`

**Request**:
```json
{
  "chat_ids": "[]",
  "system_message_ids": "[12345]"
}
```

**Parameters**:
- `chat_ids`: JSON string of regular chat IDs to delete
- `system_message_ids`: JSON string of system message IDs to delete

**Response**:
```json
{
  "success": true
}
```

**Returns**: Success confirmation after deleting chats

**Notes**:
- Both parameters are required (use "[]" for empty)
- Permanently removes chat threads
- Cannot be undone
- Commonly used to clean up resolved hijacking cases

---

## Alliance

### Get User's Alliance
**Endpoint**: `POST /api/alliance/get-user-alliance`

**Request**:
```json
{}
```

**Response**: `alliance-get-user-alliance.json`

**Returns**: User's alliance membership status, alliance ID

---

### Get Alliance Details
**Endpoint**: `POST /api/alliance/get-alliance`

**Request**:
```json
{
  "alliance_id": 12345
}
```

**Response**: `alliance-get-alliance.json`

**Returns**: Alliance name, tag, description, level, statistics

---

### Get Alliance Members
**Endpoint**: `POST /api/alliance/get-alliance-members`

**Request**:
```json
{
  "alliance_id": 12334,
  "lifetime_stats": false,
  "last_24h_stats": false,
  "last_season_stats": false,
  "include_last_season_top_contributors": true
}
```

**Response**: `alliance-get-alliance-members.json`

**Returns**: Array of alliance members with their statistics and roles

**Parameters**:
- `alliance_id`: Alliance ID to fetch members for
- `lifetime_stats`: Include lifetime statistics for each member
- `last_24h_stats`: Include last 24 hours statistics for each member
- `last_season_stats`: Include last season statistics for each member
- `include_last_season_top_contributors`: Include top contributors list from last season

**Common Variations**:
```json
// Only last season top contributors (minimal data)
{"alliance_id": 12334, "lifetime_stats": false, "last_24h_stats": false, "last_season_stats": false, "include_last_season_top_contributors": true}

// Last season stats + top contributors
{"alliance_id": 12334, "lifetime_stats": false, "last_24h_stats": false, "last_season_stats": true, "include_last_season_top_contributors": true}

// Last 24h stats + top contributors
{"alliance_id": 12334, "lifetime_stats": false, "last_24h_stats": true, "last_season_stats": false, "include_last_season_top_contributors": true}

// Lifetime stats + top contributors
{"alliance_id": 12334, "lifetime_stats": true, "last_24h_stats": false, "last_season_stats": false, "include_last_season_top_contributors": true}
```

**Response**: `alliance-get-alliance-members.json`

**Returns**: List of all alliance members with requested statistics

---

### Get Alliance Chat Feed
**Endpoint**: `POST /api/alliance/get-chat-feed`

**Request**:
```json
{
  "alliance_id": 12345,
  "offset": 0,
  "limit": 50
}
```

**Response**: `alliance-get-chat-feed.json`

**Returns**: Recent alliance chat messages and events

---

### Post Alliance Chat Message
**Endpoint**: `POST /api/alliance/post-chat`

**Request**:
```json
{
  "alliance_id": 12345,
  "text": "Great work everyone on hitting our contribution goals this week!"
}
```

**Parameters**:
- `alliance_id`: Your alliance ID
- `text`: Message content (max 1000 characters)

**Response**:
```json
{
  "success": true
}
```

**Returns**: Success confirmation after message is posted to alliance chat

**Notes**:
- Message appears immediately in alliance chat feed
- Empty messages (after trimming) are rejected
- HTML and JavaScript content is sanitized/rejected for security

---

### Get Alliance High Scores
**Endpoint**: `POST /api/alliance/get-high-scores`

**Request**:
```json
{
  "page": 0,
  "tab": "current",
  "language": "global",
  "league_level": "all",
  "score": "contribution"
}
```

**Response**: `alliance-get-high-scores.json`

**Returns**: Alliance leaderboard rankings

---

### Get Open Alliances
**Endpoint**: `POST /api/alliance/get-open-alliances`

**Request**:
```json
{
  "limit": 50,
  "offset": 0,
  "filter": "all"
}
```

**Response**: `alliance-get-open-alliances-all.json`, `alliance-get-open-alliances-open.json`

**Returns**: Paginated list of alliances

**Parameters**:
- `limit`: Number of results per page (e.g., 10, 50, 100)
- `offset`: Pagination offset (0-based)
- `filter`: "all" (all alliances) or "open" (only alliances accepting members)

**Notes**:
- Use for alliance search/directory functionality
- Paginate by incrementing `offset` by `limit` value
- Filter "all" returns all alliances regardless of recruitment status
- Filter "open" returns only alliances that are actively recruiting

---

### Get Alliance Member Settings
**Endpoint**: `POST /api/alliance/get-member-settings`

**Request**:
```json
{
  "alliance_id": 12345
}
```

**Response**: `alliance-get-member-settings.json`

**Returns**: Member permissions, roles, settings

---

### Get Alliance Settings
**Endpoint**: `POST /api/alliance/get-settings`

**Request**:
```json
{
  "alliance_id": 12345
}
```

**Response**: `alliance-get-settings.json`

**Returns**: Alliance configuration, requirements, privacy settings

---

### Get Queue Pool for Alliance
**Endpoint**: `POST /api/alliance/get-queue-pool-for-alliance`

**Request**:
```json
{
  "alliance_id": 12345,
  "pool_type": "direct",
  "filter_share_value": "any",
  "filter_fleet_size": "any",
  "filter_experience": "all",
  "page": 1
}
```

**Response**: `alliance-get-queue-pool-for-alliance.json`

**Returns**: Queue pool of available vessels/members for alliance cooperation
- `pool.direct`: Array of direct queue pool entries (vessels available for cooperation)

**Notes**:
- `pool_type`: "direct" or "any"
- `filter_share_value`: "any", "low", "medium", "high"
- `filter_fleet_size`: "any", "small", "medium", "large"
- `filter_experience`: "all" or "rookies_only"
- `page`: Pagination (1-based)

---

### Update User Role
**Endpoint**: `POST /api/alliance/update-user-role`

**Request**:
```json
{
  "user_id": 1234567,
  "role": "member"
}
```

**Response**: FIXME

**Returns**: Success/failure of role update

**Notes**:
- Requires alliance management permissions (ceo, coo, or management role)
- `role`: "ceo", "coo", "management", "member"

---

### Accept User to Join Alliance
**Endpoint**: `POST /api/alliance/accept-user-to-join-alliance`

**Request**:
```json
{
  "user_id": 12345678,
  "alliance_id": 12345
}
```

**Response**: Success/failure of accepting user

**Returns**: Confirmation that user has been accepted into the alliance

**Notes**:
- Requires alliance management permissions
- `user_id`: The ID of the user applying to join
- `alliance_id`: The ID of the accepting alliance
- User must have a pending application in the queue pool
- Upon success, user becomes a member of the alliance

---

### Decline User Direct Application
**Endpoint**: `POST /api/alliance/decline-user-direct-application`

**Request**:
```json
{
  "user_id": 12345678,
  "alliance_id": 12345
}
```

**Response**: Success/failure of declining user

**Returns**: Confirmation that user's application has been declined

**Notes**:
- Requires alliance management permissions
- `user_id`: The ID of the user whose application to decline
- `alliance_id`: The ID of the alliance
- Removes the application from the queue pool
- User can reapply after being declined

---

### Apply to Join Alliance
**Endpoint**: `POST /api/alliance/apply-direct-to-join-alliance`

**Request**:
```json
{
  "alliance_id": 12345,
  "application_text": "Let my in - I'm a pro, dude!"
}
```

**Response**: Success/failure of application submission

**Returns**: Confirmation that application has been sent to the alliance

**Notes**:
- Used by users without an alliance to apply to join an open alliance
- `alliance_id`: The ID of the alliance to apply to
- `application_text`: Optional motivational speech (max 1000 characters)
- Alliance must be open (less than 50 members)
- User can apply to multiple alliances simultaneously
- Application appears in the alliance's queue pool

---

### Join Pool for Any Alliance
**Endpoint**: `POST /api/alliance/join-pool-for-any-alliance`

**Request**:
```json
{}
```

**Response**: Success/failure of joining the any-alliance pool

**Returns**: Confirmation that user has been added to the general alliance pool

**Notes**:
- Used as a backup option when applying to specific alliances
- If not accepted to any specific alliance within 48 hours, user enters general pool
- Alliances can browse the general pool to find members
- User can only be in the pool if they have no alliance
- Automatically removed from pool when user joins an alliance

---

### Leave Pool for Any Alliance
**Endpoint**: `POST /api/alliance/leave-pool-for-any-alliance`

**Request**:
```json
{
  "time_requested_in_48h": true
}
```

**Response**: Success/failure of leaving the pool

**Returns**: Confirmation that user has been removed from the general alliance pool

**Notes**:
- Removes user from the any-alliance pool
- `time_requested_in_48h`: Whether request was made within the 48-hour window
- User can rejoin the pool at any time

---

### Cancel Application to Alliance
**Endpoint**: `POST /api/alliance/cancel-application`

**Request**:
```json
{
  "alliance_id": 12345
}
```

**Response**: Success/failure of cancellation

**Returns**: Confirmation that application has been cancelled

**Notes**:
- Cancels a specific pending application to an alliance
- `alliance_id`: The ID of the alliance to cancel application for
- Removes application from alliance's queue pool
- User can reapply to the same alliance after cancelling

---

### Leave Alliance
**Endpoint**: `POST /api/alliance/leave-alliance`

**Request**:
```json
{}
```

**Response**:
```json
{
  "success": true
}
```

**Returns**: Success confirmation after leaving the alliance

**Notes**:
- Leaves your current alliance
- User must be a member of an alliance to use this endpoint
- Cannot be undone - must reapply to rejoin
- All contribution points and alliance benefits are lost
- Immediate effect - no waiting period

---

### Cancel All Applications
**Endpoint**: `POST /api/alliance/cancel-all-applications`

**Request**:
```json
{}
```

**Response**: Success/failure of bulk cancellation

**Returns**: Confirmation that all applications have been cancelled

**Notes**:
- Cancels all pending applications to all alliances
- Does not affect any-alliance pool membership
- User can submit new applications after cancelling all

---

### Cancel Direct Application to Join Alliance
**Endpoint**: `POST /api/alliance/cancel-direct-application-to-join-alliance`

**Request**:
```json
{
  "alliance_id": 1234
}
```

**Response**: Success/failure of cancellation

**Returns**: Confirmation that specific application has been cancelled

**Notes**:
- Cancels a specific pending application to an alliance
- `alliance_id`: The ID of the alliance to cancel application for
- User can reapply to the same alliance after cancelling

---

### Get User Pool State
**Endpoint**: `POST /api/alliance/get-user-pool-state`

**Request**:
```json
{}
```

**Response**: `alliance-get-user-pool-state.json`

**Returns**: Current status of user's alliance applications

**Notes**:
- Returns the user's pending alliance applications
- `any`: Whether user is in the "any alliance" pool
- `direct`: Array of direct applications to specific alliances
- Used to track application status before joining an alliance

---

## Coop (Cooperative Play)

### Get Coop Data
**Endpoint**: `POST /api/coop/get-coop-data`

**Request**:
```json
{}
```

**Response**: `coop-get-coop-data.json`

**Returns**: Cooperative opportunities, available cargo sharing

---

### Update Coop Settings
**Endpoint**: `POST /api/coop/update-settings`

**Request**:
```json
{
  "coop_enabled": true,
  "capacity_min": 2500,
  "hhmm_from": 22,
  "hhmm_to": 6,
  "time_range_enabled": false
}
```

**Response**: `coop-update-settings.json`

---

### Donate Points (Diamonds)
**Endpoint**: `POST /api/coop/donate-points`

**Request**:
```json
{
  "user_id": 123456,
  "points": 5,
  "message": "Optional message",
  "all_members": false
}
```

**Parameters**:
- `user_id`: Target user ID (ignored if all_members=true)
- `points`: Amount of diamonds to donate (must be <= available points)
- `message`: Optional message (max 140 characters)
- `all_members`: If true, sends to all alliance members

**Response**: FIXME

**Returns**: Success/failure

**Notes**:
- Donates diamonds (points) to alliance members
- Can donate to single member or all members at once
- Total cost = points x number of recipients
- Points are deducted immediately from donor's balance

---

## Stock Market

### Get Finance Overview
**Endpoint**: `POST /api/stock/get-finance-overview`

**Request**:
```json
{
  "user_id": 1234567
}
```

**Response**: `stock-get-finance-overview.json`

**Returns**: User's stock portfolio, holdings, value

---

### Get Stock Market
**Endpoint**: `POST /api/stock/get-market`

**Request**:
```json
{
  "filter": "top",
  "page": 1,
  "limit": 40,
  "search_by": ""
}
```

**Response**: `stock-get-market.json`

**Returns**: Stock market listings (only companies with `stock_for_sale >= 1`)

**Parameters**:
- `filter`: Filter/sort type (see below)
- `page`: Page number for pagination (1-based)
- `limit`: Results per page (minimum 20, typically 40)
- `search_by`: Search query - **ONLY works with `filter: "search"`**

**Filter Options**:
| Filter | Behavior | search_by |
|--------|----------|-----------|
| `"top"` | Sort by highest stock value | IGNORED |
| `"low"` | Sort by lowest stock value | IGNORED |
| `"activity"` | Sort by trading activity | IGNORED |
| `"recent-ipo"` | Sort by IPO date (newest first) | IGNORED |
| `"search"` | Search by company name | **REQUIRED** |

**Important Notes**:
- Only companies with `stock_for_sale >= 1` appear in results
- Companies with 0 shares for sale are NOT listed
- The `search_by` parameter is completely ignored for all filters except `"search"`
- IPO date can be determined from `history[0].time` in finance-overview response

**Search Example**:
```json
{
  "filter": "search",
  "page": 1,
  "limit": 40,
  "search_by": "foobar"
}
```
Returns only companies matching "foobar" in their name and stocks_for_sale > 1

---

### Get Stock Information
**Endpoint**: `POST /api/stock/get-stock`

**Request**:
```json
{
  "user_id": 1234567
}
```

**Response**: `stock-get-stock.json`

**Returns**: Stock information for specific user/company

**Notes**: Returns detailed stock data including price, trend, trading volume

---

### Purchase Stock
**Endpoint**: `POST /api/stock/purchase-stock`

**Request**:
```json
{
  "stock_issuer_user_id": 1234567,
  "amount": 100
}
```

**Parameters**:
- `stock_issuer_user_id`: ID of the company/user whose stock to purchase
- `amount`: Number of shares to buy (must be >= 1)

**Response**:
```json
{
  "success": true,
  "user": {
    "cash": 45000000
  }
}
```

**Returns**: Success confirmation with updated cash balance after purchase

**Notes**:
- Purchases stock shares from another player's company
- Cash is deducted immediately based on current stock price
- Company must have done IPO (gone public)
- Returns error "user_has_not_done_ipo" if company is not public
- This is a DESTRUCTIVE action that spends money

---

### Sell Stock
**Endpoint**: `POST /api/stock/sell-stock`

**Request**:
```json
{
  "stock_user_id": 1234567,
  "amount": 100
}
```

**Parameters**:
- `stock_user_id`: ID of the company/user whose stock to sell
- `amount`: Number of shares to sell (must be >= 1)

**Response**: `stock-sell-stock.json`

**Returns**: Success confirmation with revenue from sale

**Notes**:
- Sells stock shares you own from another player's company
- Cash is credited immediately based on current stock price
- You must own at least `amount` shares to sell
- This action generates income

---

### Increase Stock For Sale
**Endpoint**: `POST /api/stock/increase-stock-for-sale`

**Request**:
```json
{}
```

**Response**: `stock-increase-stock-for-sale.json`

**Returns**: Updated user data after issuing new shares

**Notes**:
- Only available for users who have completed IPO (gone public)
- Each call issues exactly 25,000 new shares to the market
- Triggered from stock graph page via + button next to 'Shares (Sale/Total)' legend
- Price doubles with each tier based on total shares in circulation:
  - 0-25k shares: $6.5M
  - 25k-50k shares: $12.5M
  - 50k-75k shares: $25M
  - 75k-100k shares: $50M
  - (doubles each subsequent tier)
- This is a DESTRUCTIVE action that spends money

---

## Shop

### Get Money Products (IAP)
**Endpoint**: `POST /api/shop/get-money-products`

**Request**:
```json
{
  "platform": "web"
}
```

**Response**: `shop-get-money-products.json`

**Returns**: Available in-app purchase products (premium currency)

---

### Get Points Products
**Endpoint**: `POST /api/shop/get-points-products`

**Request**:
```json
{
  "platform": "web"
}
```

**Response**: `shop-get-points-products.json`

**Returns**: Items purchasable with in-game points

---

## Leaderboards

### Top List by Difficulty
**Endpoint**: `POST /api/top-list/by-difficulty-mode`

**Request**:
```json
{
  "difficulty": "easy",
  "page": 1
}
```

**Response**: `top-list-by-difficulty-mode.json`

**Returns**: Global leaderboard for specific difficulty

**Notes**: Difficulty options: "easy", "normal", "hard"

---

### Competitors
**Endpoint**: `POST /api/top-list/competitors`

**Request**:
```json
{}
```

**Response**: `top-list-competitors.json`

**Returns**: Players near your ranking

---

## League System

### Get User League and Group
**Endpoint**: `POST /api/league/get-user-league-and-group`

**Request**:
```json
{}
```

**Response**: `league-get-user-league-and-group.json`

**Returns**: Current league, division, ranking within group

---

## Live Operations

### Get Campaign
**Endpoint**: `POST /api/live-ops/get-campaign`

**Request**:
```json
{
  "trigger": "login"
}
```

**Response**: `live-ops-get-campaign.json`

**Returns**: Active promotional campaigns, events, offers

**Notes**: Trigger types seems to be something like: "login", "shop_open", "level_up", etc.

---

### Get Campaign (Alternative)
**Endpoint**: `POST /api/campaign/get-campaign`

**Request**:
```json
{}
```

**Response**: `campaign-get-campaign.json`

**Returns**: Active campaigns with status information

**Notes**:
- Alternative endpoint for getting campaign information
- Returns campaign list with status (active/inactive)
- Used internally for tracking active campaign count

---

## Marketing

### Get Marketing Campaigns
**Endpoint**: `POST /api/marketing-campaign/get-marketing`

**Request**:
```json
{}
```

**Response**: `marketing-campaign-get-marketing.json`

**Returns**: Active marketing campaigns and promotions

---

### Activate Marketing Campaign
**Endpoint**: `POST /api/marketing-campaign/activate-marketing-campaign`

**Request**:
```json
{
  "campaign_id": 1
}
```

**Parameters**:
- `campaign_id`: ID of the marketing campaign to activate

**Response**:
```json
{
  "success": true
}
```

**Returns**: Success confirmation after campaign is activated

**Notes**:
- Activates a marketing campaign to boost vessel performance
- Campaigns have duration and cost
- Only one campaign can be activeted at a time
- Effects apply immediately

---

## Anchor Point

### Get Anchor Price
**Endpoint**: `POST /api/anchor-point/get-anchor-price`

**Request**:
```json
{}
```

**Response**: `anchor-point-get-anchor-price.json`

**Returns**: Current price per anchor point, duration, and user data including:
- `price`: Cost per anchor point in dollars
- `duration`: Time required for construction (in seconds)
- `user.cash`: User's current cash balance
- `user.points`: User's premium currency balance

---

### Purchase Anchor Points
**Endpoint**: `POST /api/anchor-point/purchase-anchor-points`

**Request**:
```json
{
  "amount": 1
}
```

**Response**: `anchor-point-purchase-anchor-points.json`

**Returns**: Success/failure, completion timestamp
- `success`: true/false
- `anchor_next_build`: Unix timestamp when anchor point will be ready
- Total cost: `price * amount`

**Notes**:
- **DESTRUCTIVE ACTION** - Spends cash immediately
- Anchor points increase vessel capacity
- Construction takes time
- Requires sufficient cash balance

---

### Reset Anchor Timing (Instant Completion)
**Endpoint**: `POST /api/anchor-point/reset-anchor-timing`

**Request**:
```json
{}
```

**Response**: FIXME

**Returns**: Success/failure

---

## Hijacking (Piracy)

### Get Hijacking Case
**Endpoint**: `POST /api/hijacking/get-case`

**Request**:
```json
{
  "case_id": 1234567
}
```

**Response**: `hijack-get-case-12345678.json`

**Returns**: Hijacking case details including:
- Vessel information
- Pirate demands (requested_amount)
- User proposal (user_proposal, if negotiation started)
- Negotiation status (has_negotiation: 0 or 1)
- Current state of the ransom negotiation

**Notes**:
- Called when user receives a hijacking message notification
- `has_negotiation: 1` indicates negotiation was done at least ones
- `requested_amount`: Original pirate ransom demand (will be reduced with every pirate count offer)
- `user_proposal`: User's counter-offer (if submitted)

---

### Submit Ransom Offer
**Endpoint**: `POST /api/hijacking/submit-offer`

**Request**:
```json
{
  "case_id": 1234567,
  "amount": 1888000
}
```

**Response**: (NOT auto-fetched - destructive action)

**Returns**: Success/failure of counter-offer submission

**Notes**:
- Used to negotiate ransom amount with pirates
- Amount is in dollars
- Pirates never accept or reject they only re-counter your offer 2 times
- Sending amounts different from 25/50/75 % or sending more offers as the allowed 2 > Pirates wanna scam you. (Responese payment price isn't the value the is taken from your balance :D)
- Response appears as new message in messenger thread
- Multiple negotiation rounds possible

---

### Pay Ransom
**Endpoint**: `POST /api/hijacking/pay`

**Request**:
```json
{
  "case_id": 1234567
}
```

**Parameters**:
- `case_id`: ID of the hijacking case to pay ransom for

**Response**:
```json
{
  "success": true,
  "user": {
    "cash": 45000000
  }
}
```

**Returns**: Success confirmation with updated user cash balance after payment

**Notes**:
- Pays the agreed ransom to close the hijacking case
- Cash is deducted from user balance immediately
- Vessel is released after payment
- Case status changes to "solved"
- Payment amount is determined by negotiation or original demand
- This is a DESTRUCTIVE action that spends money

---

## Advertisements

### Get Map Ads Info
**Endpoint**: `GET /api/ad/get-map-ads-info`

**Request**: None (GET request, no body)

**Response**: `ad-get-map-ads-info.json`

**Returns**: Information about map advertisement rewards and cooldown status

**Notes**:
- This is a GET request, not POST
- `map_ad_reward`: Anchor Points reward for watching an ad
- `map_ad_cooldown`: Seconds until next ad can be watched (0 = ready)
- Used by the game to display ad availability on the map

---

## Public Endpoints

### Get Languages
**Endpoint**: `POST /api/public/get-languages`

**Request**:
```json
{}
```

**Response**: `public-get-languages.json`

**Returns**: All supported languages and translations

---

### Log Error
**Endpoint**: `POST /api/public/log-error`

**Request**:
```json
{
  "user_id": 1234567,
  "error": "VUE_ERROR",
  "message": "Cannot read properties of null",
  "info": "TypeError - GameMap",
  "location": "Current page - No page",
  "game_version": "1.0.310",
  "platform": "Google Chrome or Chromium",
  "component_name": "GameMap",
  "modal_history": "No history"
}
```

**Response**: FIXME

**Returns**: Success acknowledgment

---

## Analytics

### Send Delta Event
**Endpoint**: `POST /api/deltadna/send-delta-event`

**Request**:
```json
{
  "name": "shopOpen",
  "params": {
    "storePath": "Unknown",
    "storePage": "packs"
  }
}
```

**Response**: `deltadna-send-delta-event.json`

---

## Rate Limiting

The actual game API rate limit is well above 200 req/s.

## Error Responses

Common error status codes:

- **200**: Success
- **400**: Bad request (invalid parameters)
- **401**: Unauthorized (invalid/expired session)
- **403**: Forbidden (action not allowed)
- **429**: Rate limit exceeded
- **500**: Server error
