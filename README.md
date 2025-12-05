# 🚢 Shipping Manager - CoPilot

A comprehensive "Addon" for the beloved game [Shipping Manager](https://shippingmanager.cc).

## Key Features at a Glance

* **Harbor Map**: Interactive world map with live fleet tracking, vessel/port details, route visualization, **weather overlays (rain, temperature, wind)**, and **maritime POI (museums, shipwrecks)**
* **Logbook**: Comprehensive event tracking for alliance activities, vessel operations, and game history
* **AutoPilot System**: Intelligent automation for fuel/CO2 purchasing, vessel operations, hijacking negotiation, and more
* **ChatBot**: Automated alliance assistant with **role-based commands**, scheduled announcements, and custom command support
* **Mobile Support**: As a Steam player, you can now receive **mobile notifications** via your Wi-Fi at home
* **Fleet Management**: Streamlined vessel purchasing, **bulk repairs**, automated departures, and **bulk selling with shopping cart**
* **Price Alerts**: Set up your own custom price alerts!
* **Alliance Cooperation**: Easily manage and send cooperation vessels to alliance members
* **Company Profile**: Track your achievements, progress, and company statistics
* **Bug-Free Chat**: Alliance chat and private messaging **without the page reload bugs** that Steam players commonly experience with [Shippingmanager.cc](https://shippingmanager.cc/)

...and much more!

[Discord Community](https://discord.gg/rw4yKxp7Mv)!

---

## Table of Contents

- [The Bug That Became The Tool](#️-the-bug-that-became-the-tool)
- [Features](#-features)
- [Installation](#installation)
- [Documentation](#documentation)
- [Session Cookie Encryption](#session-cookie-encryption)
- [Legal Disclaimer & Risk Notice](#legal-disclaimer--risk-notice)
- [Security Notice](#security-notice)
- [Privacy & Data Collection](#privacy--data-collection)
- [License](#license)
- [Screenshots](#screenshots)

---

## 🛠️ The Bug That Became The Tool

This project started out of sheer **frustration with persistent bugs** in [Shipping Manager](https://shippingmanager.cc) and the complete lack of ongoing development by the creators.

Initially, I just wanted to build a **simple chat messenger** – something that would allow me to communicate with my alliance on Steam without constantly worrying about certain keystrokes triggering a full page reload (a well-known bug in the Steam Version that never gets fixed).

What truly annoyed me was the inability to log in through a standard browser using my Steam account to receive game notifications while moving around the house or to earn **Point Rewards from Ads on my mobile device**.

Given that I have paid money for in-game items, it felt a bit like **"I got scammed."** I decided: I want to create my own benefits, especially since I can't watch ads to earn points or even receive notifications while I'm at home...

Well... things got a little out of hand, and the result is what you see here now :-D

This **comprehensive standalone web interface** connects directly to the Shipping Manager API and is packed with features the normal game is missing.

---

## 🚀 Features

### Core Features

| Feature | Description |
|---------|-------------|
| **Bug-Free Chat** | Alliance chat and private messaging without Steam's page reload bugs |
| **Harbor Map** | Interactive world map with live fleet tracking, weather overlays, route visualization, and maritime POIs |
| **Logbook** | Comprehensive event tracking with search, filters, and CSV/JSON export |
| **Forecast Calendar** | 30-minute precision fuel/CO2 price forecasts with multi-day planning |
| **Route Planner** | Visual destination selection with real-time cost/fuel/piracy calculations |
| **Company Profile** | Achievement tracking, analytics dashboard, and performance metrics |

### Fleet Management

| Feature | Description |
|---------|-------------|
| **Depart Manager** | Fleet dashboard with bulk departures, status tabs, and map integration |
| **Drydock Management** | Bulk drydock operations with cost previews and maintenance scheduling |
| **Bulk Repair** | One-click repairs with configurable wear thresholds and cost preview |
| **Vessel Building** | Custom vessel construction with appearance editor and fast delivery option |
| **Vessel Selling** | Bulk sales with shopping cart and real-time price verification |
| **Anchor Points** | Fleet capacity management with one-click purchasing |

### Business & Analytics

| Feature | Description |
|---------|-------------|
| **Business Analytics** | BI tools with performance metrics, trends, and historical data |
| **Stock Manager** | IPO stock tracking, price alerts, and portfolio management |
| **The Purser** | Automated dividend collection and stock monitoring (IPO users) |
| **Alliance League** | Real-time league standings, progress tracking, and seasonal stats |
| **Marketing Campaigns** | Campaign management with status badges and one-click activation |

### AutoPilot System

Intelligent automation with configurable thresholds and emergency buy override:

| AutoPilot | Function |
|-----------|----------|
| **Barrel Boss** | Auto-rebuy fuel when price drops below threshold |
| **Atmosphere Broker** | Auto-rebuy CO2 when price drops below threshold |
| **Cargo Marshal** | Auto-depart vessels with demand validation and route optimization |
| **Yard Foreman** | Auto bulk repair when wear exceeds threshold |
| **Reputation Chief** | Auto campaign renewal to prevent downtime |
| **Fair Hand** | Auto coop vessel distribution to alliance members |
| **Harbormaster** | Auto anchor point purchasing when capacity needed |
| **Cap'n Blackbeard** | Auto hijacking negotiation with aggressive counter-offers |
| **The Purser** | Auto dividend collection (IPO users only) |

All AutoPilots support **Emergency Buy Override**: Configure minimum bunker level, ships at port threshold, and max price for emergency purchases.

### ChatBot

Automated alliance assistant with role-based commands, scheduled announcements (forecast, welcome), custom commands, anti-spam cooldowns, and configurable prefixes.

**Broadcast Templates**: Management roles (CEO, COO, Management) can send templated DMs to alliance members:
- `!msg <template> [userID]` - Send template to single user
- `!msg <template> [id1] [id2] [id3]` - Send template to multiple users
- Built-in templates: `coop`, `inactive`, `reminder` (customizable)

**DM Queue**: All private messages are queued and sent with 45-second intervals to respect Game API rate limits. Success/failure notifications appear in alliance chat.

### Additional Features

- **Price Alerts**: Custom fuel/CO2 price notifications with desktop alerts
- **Alliance Coop Center**: Member list with color-coded status and one-click vessel dispatch
- **Hijacking Management**: Multi-tier negotiation (25%/50%/75%) with payment integration
- **Mobile Notifications**: Receive game alerts via Wi-Fi on mobile devices
- **HTTPS & Certificates**: Auto-generated certificates with LAN access and QR codes for mobile

***

## Installation

- **Installation Guide**: See [docs/tutorials/01-installation-guide.md](docs/tutorials/01-installation-guide.md)

### Windows Users (Using .exe Installer)
- Modern web browser (Chrome/Chromium recommended)
- Active Shipping Manager account (Steam, Browser, or Mobile Account)

**[Download the latest release here](https://github.com/justonlyforyou/shippingmanager_copilot/releases/latest)**

###  Linux/Mac Users
- Modern web browser (Chrome/Chromium recommended)
- Active Shipping Manager account (Steam, Browser, or Mobile Account)

**NOTE:** Please, keep in mind Mac & Linux is fully untested!

**[Download the latest release here](https://github.com/justonlyforyou/shippingmanager_copilot/releases/latest)**

### Developers (Running from Source)

- **Build Guide**: See [docs/tutorials/02-build-guide.md](docs/tutorials/02-build-guide.md)

***

## Documentation

Comprehensive JSDoc documentation is available when the application is running:

- Click the docs button in the UI (next to settings)

The documentation includes build instructions, installation guides, and complete API reference for all modules.

***

## Session Cookie Encryption

**All session cookies are automatically encrypted using OS-native secure storage!**

### How It Works

Session cookies are stored in `userdata/settings/sessions.json` (or `AppData/Local/ShippingManagerCoPilot/userdata/settings/sessions.json` when installed) but **never in plaintext**. The file only contains encrypted references like `KEYRING:session_1234567`. The actual cookie values are securely stored in your operating system's credential manager.

### Cross-Platform Security Backends

The application automatically uses the most secure storage available for your platform:

#### **Windows**
- **Backend**: Windows DPAPI (Data Protection API) + Credential Manager
- **Security**: Encrypted with your Windows user account credentials
- **Access**: Only you on this specific machine can decrypt
- **Location**: Windows Credential Manager (`Control Panel > Credential Manager`)

#### **macOS**
- **Backend**: macOS Keychain
- **Security**: Encrypted with Keychain encryption
- **Access**: Only you on this specific machine can decrypt
- **Location**: Keychain Access app

#### **Linux**
- **Backend**: libsecret (GNOME Keyring / KWallet)
- **Security**: Encrypted with Secret Service API
- **Access**: Only you on this specific machine can decrypt
- **Requirements**: `libsecret-1-dev` package must be installed

### Benefits

- **No plaintext cookies**: Even if someone copies your `sessions.json`, they cannot use it
- **Machine-locked**: Cookies can only be decrypted on the same machine by the same user
- **Zero configuration**: Works automatically, no setup required
- **New sessions protected**: All newly saved sessions are encrypted immediately

***

## Legal Disclaimer & Risk Notice

**This tool is not affiliated with Shipping Manager or Steam.**

**WARNING: USE OF THIS TOOL IS AT YOUR OWN RISK!**

This tool implements automated procedures to extract session cookies from the local Steam client cache and interacts directly with the game's API (`shippingmanager.cc`).

1.  **Violation of ToS:** These techniques **most likely** violate the Terms of Service (ToS) of both **Steam** and **Shipping Manager**.
2.  **Potential Consequences:** Use of this tool may lead to the **temporary suspension** or **permanent ban** of your Steam or game account.
3.  **No Liability:** The developers of this tool **assume no liability** for any damages or consequences resulting from its use. **Every user is solely responsible for complying with the respective terms of service.**

***

## Privacy & Data Collection

**This application collects ZERO data from users.**

- **No telemetry**: The software does not send any usage data, statistics, or analytics to the developer
- **No tracking**: Your gameplay data, account information, and activity remain completely private
- **Local only**: All data is stored locally on your machine (settings.json, session cookies in memory)
- **No external servers**: The application only communicates with shippingmanager.cc API - never with developer servers
- **Open source**: You can verify the code yourself - there are no hidden data collection mechanisms

**The developer has zero interest in your data.** This tool was created to solve a game bug, not to collect user information.

***

## License

AGPL-3.0-only WITH Commons Clause License Condition v1.0

Copyright (c) 2024-2025 sitzmoebelchronograph

This software is free to use and modify, but **may not be sold commercially**. See [LICENSE](LICENSE) file for full terms.

***

## Screenshots

### Startup & Overview

<img src="screenshots/1_smcopilot_startup.png" width="50%">
<img src="screenshots/1_smcopilot_startup1.png" width="50%">
<img src="screenshots/2_smcopilot_overview_noally.png" width="50%">

### Fuel & CO2 Management

<img src="screenshots/3_smcopilot_purchase_fuel.png" width="50%">
<img src="screenshots/4_smcopilot_purchase_co2.png" width="50%">

### Vessel Management

<img src="screenshots/5_smcopilot_buy_vessels_.png" width="50%">
<img src="screenshots/5_smcopilot_buy_vessels_filter1.png" width="50%">
<img src="screenshots/5_smcopilot_buy_vessels_filter2.png" width="50%">
<img src="screenshots/5_smcopilot_buy_vessels_cart.png" width="50%">

### Vessel Selling

<img src="screenshots/6_smcopilot_sell_vessels_1.png" width="50%">
<img src="screenshots/6_smcopilot_sell_vessels_2.png" width="50%">

### Bulk Operations

<img src="screenshots/7_smcopilot_bulk_repair.png" width="50%">
<img src="screenshots/8_smcopilot_marketing_ampaigns.png" width="50%">

### Forecast & Anchor Points

<img src="screenshots/9_smcopilot_forecast.png" width="50%">
<img src="screenshots/10_smcopilot_purchase_anchorpoints.png" width="50%">

### Settings

<img src="screenshots/11_1_smcopilot_settings_pricealert.png" width="50%">
<img src="screenshots/11_2_smcopilot_settings_general.png" width="50%">
<img src="screenshots/14_smcopilot_settings_certs.png" width="50%">

### ChatBot

<img src="screenshots/12_1_smcopilot_chatbot_general.png" width="50%">
<img src="screenshots/12_2_smcopilot_chatbot_forecast.png" width="50%">
<img src="screenshots/12_3_smcopilot_chatbot_help_command.png" width="50%">
<img src="screenshots/12_4_smcopilot_chatbot_custom_commands.png" width="50%">

### AutoPilot

<img src="screenshots/13_1_smcopilot_autopilot_settings.png" width="50%">
<img src="screenshots/13_2_smcopilot_autopilot_barrel_boss.png" width="50%">
<img src="screenshots/13_3_smcopilot_autopilot_atmosphere_broker.png" width="50%">
<img src="screenshots/13_4_smcopilot_autopilot_cargo_marshal.png" width="50%">
<img src="screenshots/13_5_smcopilot_autopilot_harbormaster.png" width="50%">
<img src="screenshots/13_6_smcopilot_autopilot_reputation_Chief.png" width="50%">
<img src="screenshots/13_7_smcopilot_autopilot_fairhand.png" width="50%">
<img src="screenshots/13_8_smcopilot_autopilot_captain_blackbeard.png" width="50%">
<img src="screenshots/13_9_smcopilot_autopilot_yardforeman.png" width="50%">

### Logbook

<img src="screenshots/15_1_smcopilot_logbook.png" width="50%">
<img src="screenshots/15_2_smcopilot_logbook_details1.png" width="50%">
<img src="screenshots/15_3_smcopilot_logbook_details2.png" width="50%">
<img src="screenshots/15_4_smcopilot_logbook_details3.png" width="50%">
<img src="screenshots/15_5_smcopilot_logbook_details4.png" width="50%">

### Harbor Map

<img src="screenshots/16_1_smcopilot_map_overview.png" width="50%">
<img src="screenshots/16_2_smcopliot_map_cluster1.png" width="50%">
<img src="screenshots/16_3_smcopilot_map_cluster2.png" width="50%">
<img src="screenshots/16_4_smcopilot_map_modes.png" width="50%">
<img src="screenshots/16_5_smcopilot_map_filters.png" width="50%">
<img src="screenshots/16_6_smcopilo_map_harbor_click.png" width="50%">
<img src="screenshots/16_7_smcopilot_map_harbor_click_details.png" width="50%">
<img src="screenshots/16_8_smcopilot_map_vessel_click.png" width="50%">
<img src="screenshots/16_9_smcopilot_map_vessel_click_details1.png" width="50%">
<img src="screenshots/16_10_smcopilot_map_vessel_click_details2.png" width="50%">
<img src="screenshots/16_11_smcopilot_map_vessel_click_details3.png" width="50%">
<img src="screenshots/16_12_smcopilot_map_vessel_click_details4.png" width="50%">
<img src="screenshots/16_13_smcopilot_map_vessel_click_details_vessel-history_export.png" width="50%">
