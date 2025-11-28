/**
 * @fileoverview Analytics Aggregation Module
 *
 * Reads audit log and trip data to calculate analytics summaries:
 * - Weekly/daily revenue, expenses, profit
 * - Vessel performance metrics
 * - Route profitability analysis
 * - Fuel/CO2 purchase analysis
 * - Harbor fee analysis by port
 * - Contribution tracking
 *
 * All data is LOCAL (JSON files) - no API calls needed.
 * Expected load time: ~100-200ms for full analytics data.
 *
 * @module server/analytics/aggregator
 */

const fs = require('fs').promises;
const path = require('path');
const logger = require('../utils/logger');
const { getLogDir, getAppDataDir } = require('../config');
const transactionStore = require('./transaction-store');
const vesselHistoryStore = require('./vessel-history-store');
const { formatPortAbbreviation } = require('../routes/harbor-map-aggregator');

// Port code to country code mapping
const PORT_COUNTRIES = {
  boston_us: 'US', new_york_city: 'US', philadelphia: 'US', baltimore: 'US', norfolk: 'US',
  mobile: 'US', new_orleans: 'US', houston: 'US', los_angeles: 'US', oakland: 'US',
  portland_l: 'US', seattle: 'US', port_of_alaska: 'US', port_of_nome: 'US', honolulu_harbor: 'US',
  miami: 'US', charleston: 'US', jacksonville: 'US', tampa: 'US', savannah: 'US', wilmington: 'US',
  vancouver: 'CA', halifax: 'CA', canaport_st_john: 'CA', port_of_montreal: 'CA',
  port_prince_rupert: 'CA', st_johns: 'CA', Iqaluit: 'CA', cornor_brook: 'CA',
  puerto_moin: 'CR', puerto_caldera: 'CR', port_of_corinto: 'NI', puerto_cortes: 'HN',
  puerto_de_san_lorenzo: 'HN', port_of_acajutla: 'SV', santo_tomas_de_castilla: 'GT',
  puerto_quetzal: 'GT', puerto_de_belice: 'BZ', veracruz: 'MX', port_of_ensenada: 'MX',
  port_of_manzanillo_colima: 'MX', port_of_altamira: 'MX', port_of_lazaro_cardenas: 'MX', mazatlan: 'MX',
  puerto_de_montevideo: 'UY', tubarao: 'BR', rio_de_janeiro: 'BR', santos: 'BR', rio_grande_br: 'BR',
  port_of_balboa: 'PA', port_of_manzanillo_colon: 'PA', port_of_cartagena: 'CO',
  port_of_buenaventura: 'CO', port_of_guayaquil: 'EC', port_of_callao: 'PE',
  port_of_valparaiso: 'CL', punta_arenas_port: 'CL', antofogasta: 'CL',
  port_of_buenos_aires: 'AR', port_of_ushuaia: 'AR', puerto_madryn: 'AR',
  degrad_des_cannes: 'GF', port_of_georgetown: 'GY', port_of_vila_do_conde: 'BR',
  port_of_fortaleza: 'BR', puerto_cabello: 'VE', salvador: 'BR', suape: 'BR', asuncion: 'PY',
  point_lisas: 'TT', port_of_spain: 'TT', port_of_san_juan: 'PR', port_au_prince: 'HT',
  port_of_boca_china: 'DO', port_of_kingston: 'JM', port_of_bridgetown: 'BB',
  fort_de_france: 'MQ', port_of_st_georges: 'GD', freeport_container_port: 'BS',
  port_of_nassau: 'BS', marsh_harbour: 'BS', mariel: 'CU', santiago_de_cuba: 'CU',
  camden_park: 'VC', port_castries: 'LC', port_of_woodbridge_bay: 'DM',
  port_of_guadeloupe: 'GP', saint_johns: 'AG', port_of_basseterre: 'KN',
  port_said: 'EG', damietta: 'EG', alexandria: 'EG', ain_sukhna_terminal: 'EG',
  alger: 'DZ', oran: 'DZ', casablanca: 'MA', agadir: 'MA', lagos: 'NG',
  cape_town: 'ZA', durban: 'ZA', east_london: 'ZA', gqeberha: 'ZA',
  muqdisho: 'SO', berbera: 'SO', benghazi: 'LY', tripoli: 'LY', marsa_al_brega: 'LY',
  sfax: 'TN', tunis: 'TN', bizerte: 'TN', nouadhibou: 'MR', nouakchott: 'MR',
  praia: 'CV', porteo_grande: 'CV', dakar: 'SN', banjul: 'GM', bissau: 'GW',
  conakry: 'GN', freetown: 'SL', monrovia: 'LR', abidjan: 'CI', tema: 'GH',
  lome: 'TG', cotonou: 'BJ', port_of_onne: 'NG', bata: 'GQ', malabo: 'GQ',
  port_gentil: 'GA', libreville: 'GA', port_of_sao_tome: 'ST', pointe_noire: 'CG',
  matadi: 'CD', cabina: 'AO', luanda: 'AO', lobito: 'AO', soyo: 'AO', namibe: 'AO',
  walvis_bay: 'NA', maputo: 'MZ', beira: 'MZ', nacala: 'MZ', longoni: 'YT',
  moroni: 'KM', toamasina: 'MG', majunga: 'MG', dar_es_salam: 'TZ',
  port_of_zansibar: 'TZ', tanga: 'TZ', mombasa: 'KE', djibouti: 'DJ',
  mitsiwa: 'ER', port_sudan: 'SD',
  brisbane: 'AU', port_of_botany_sydney: 'AU', melbourne: 'AU', fremantle: 'AU',
  port_headland: 'AU', port_of_darwin: 'AU', adelaide: 'AU', port_of_burnie: 'AU',
  port_of_townsville: 'AU', auckland: 'NZ', wellington: 'NZ', port_of_napier: 'NZ',
  christchurch_lyttelton: 'NZ', nelson: 'NZ', bluff: 'NZ',
  port_moresby: 'PG', lae: 'PG', madang: 'PG', male: 'MV', port_victoria: 'SC',
  port_louis: 'MU', lautoka: 'FJ', la_reunion: 'RE', motu_uta: 'FR', nakualofa: 'TO',
  apia: 'WS', port_vila: 'VU', luganville: 'VU', noumea: 'NC', honiara: 'SB',
  stanley: 'FK', hamilton: 'BM',
  oslo: 'NO', bergen: 'NO', goteborg: 'SE', malmo: 'SE', stockholm_norvik: 'SE',
  oulu: 'FI', kokkola: 'FI', pori: 'FI', vousaari_port_of_helsinki: 'FI', kotka: 'FI',
  sankt_peterburg: 'RU', muuga_port_of_tallinn: 'EE', gdansk: 'PL',
  rostock: 'DE', kiel: 'DE', hamburg: 'DE', bremerhaven: 'DE', bremen: 'DE',
  kobenhavn: 'DK', aalborg: 'DK', port_of_aarhus: 'DK',
  amsterdam: 'NL', rotterdam: 'NL', antwerpen: 'BE',
  london: 'GB', teesport: 'GB', belfast: 'GB', liverpool: 'GB', southampton: 'GB',
  port_of_le_havre: 'FR', port_of_dunkerque: 'FR', rade_de_brest: 'FR', bordeaux: 'FR',
  port_of_marseille: 'FR', edoard_herriot_port_of_lyon: 'FR', gennevilliers_port_of_paris: 'FR',
  lisboa: 'PT', sines: 'PT', ponta_delgada: 'PT',
  las_palmas: 'ES', tarragona: 'ES', barcelona: 'ES', cadiz: 'ES', oviedo: 'ES',
  bilbao: 'ES', valencia: 'ES', nalaga: 'ES', port_of_algeciras: 'ES',
  genova: 'IT', napoli: 'IT', porto_di_lido_venezia: 'IT', trieste: 'IT',
  ancona: 'IT', livorna: 'IT', port_of_palermo: 'IT', port_of_cagliari: 'IT', port_of_gioia_tauro: 'IT',
  rijeka_luka: 'HR', split: 'HR', port_of_piraeus: 'GR', thessaloniki: 'GR',
  istanbul: 'TR', samsun: 'TR', izmir: 'TR', varna: 'BG', odesa: 'UA',
  novorossiysk: 'RU', kaliningrad: 'RU', vladivostok: 'RU',
  port_of_petropavlovsk_kamchatskiy: 'RU', providenija: 'RU', abk_morskogo_porta_sabetta: 'RU', murmansk: 'RU',
  giurgiulesti: 'MD', nuuk: 'GL', torshavn: 'FO', akureyri: 'IS', reykjavik: 'IS',
  dublin: 'IE', longyearbyen: 'SJ', malta_freeport: 'MT', poti: 'GE', batumi: 'GE',
  limassol: 'CY', latakia: 'SY', bayrut: 'LB',
  mina_jabal_ali: 'AE', bombay: 'IN', madras: 'IN', calcutta: 'IN', kochi: 'IN',
  visakhapatnam: 'IN', port_klang: 'MY', johor: 'MY', bintulu: 'MY', sarawak: 'MY',
  labuan: 'MY', sepangar: 'MY', tawau: 'MY', port_of_penang: 'MY',
  port_of_singapore: 'SG', jakarta: 'ID', surabaya: 'ID', belawan: 'ID', panjang: 'ID',
  palembang: 'ID', lembar: 'ID', makassar: 'ID', banjrmasin: 'ID', pontianak: 'ID',
  balikpapan: 'ID', ambon: 'ID', gorontalo: 'ID', manokwari: 'ID', sorong: 'ID',
  merauke: 'ID', jayapura: 'ID', tenau: 'ID', waingapu: 'ID',
  bangkok: 'TH', laem_chabang: 'TH', port_of_songkhla: 'TH',
  hong_kong: 'HK', chi_lung: 'TW', port_of_kaohsiung: 'TW',
  manila: 'PH', cebu: 'PH', shanghai: 'CN', qingdao_gang: 'CN', tianjin_xin_gang: 'CN',
  dalian: 'CN', haikou: 'CN', macau: 'CN', zhanjiang: 'CN', quanzhou: 'CN',
  port_of_ningbo_zhoushan: 'CN', port_of_shenzhen: 'CN', port_of_guangzhou: 'CN',
  inchon: 'KR', pusan: 'KR', port_of_nagoya: 'JP', osaka: 'JP', wakamatsu: 'JP',
  nagasaki: 'JP', niigata: 'JP', tokyo: 'JP', port_of_sendai: 'JP', ishikari: 'JP', hiroshima: 'JP',
  king_abdullah_port: 'SA', jeddah: 'SA', jubail: 'SA', damman: 'SA',
  colombo: 'LK', karachi: 'PK', port_of_shahid_rajaee: 'IR',
  shuaiba: 'KW', al_hidd: 'BH', mesaieed: 'QA', ras_laffan: 'QA',
  aden: 'YE', al_hudaydah: 'YE', salalah: 'OM', sohar: 'OM',
  yangon: 'MM', chattogram: 'BD', mongla: 'BD',
  hai_phong: 'VN', da_nang: 'VN', ho_chi_minh_city: 'VN', sihanoukville: 'KH', nampo: 'KP',
  dili: 'TL', port_of_easter_island: 'CL', port_of_manaus: 'BR'
};

/**
 * Format route display like "DE HAM <> NL RTM"
 * @param {string} routeStr - Route string like "hamburg<>rotterdam"
 * @returns {string} Formatted route display
 */
function formatRouteDisplay(routeStr) {
  if (!routeStr) return '-';
  const parts = routeStr.split('<>');
  if (parts.length !== 2) return routeStr;

  const [origin, destination] = parts;
  const originCountry = PORT_COUNTRIES[origin] || '??';
  const destCountry = PORT_COUNTRIES[destination] || '??';
  const originAbbr = formatPortAbbreviation(origin);
  const destAbbr = formatPortAbbreviation(destination);

  return `${originCountry} ${originAbbr} <> ${destCountry} ${destAbbr}`;
}

// Use AppData when packaged as exe
const isPkg = !!process.pkg;

/**
 * Get audit log file path for a user
 * @param {string} userId - User ID
 * @returns {string} File path
 */
function getAuditLogPath(userId) {
  const logDir = path.join(getLogDir(), 'autopilot');
  return path.join(logDir, `${userId}-autopilot-log.json`);
}

/**
 * Get trip data file path for a user
 * @param {string} userId - User ID
 * @returns {string} File path
 */
function getTripDataPath(userId) {
  const tripDataDir = isPkg
    ? path.join(getAppDataDir(), 'ShippingManagerCoPilot', 'userdata', 'trip-data')
    : path.join(__dirname, '../../userdata/trip-data');
  return path.join(tripDataDir, `trip-data-${userId}.json`);
}

/**
 * Load audit log for a user
 * @param {string} userId - User ID
 * @returns {Promise<Array>} Array of log entries
 */
async function loadAuditLog(userId) {
  try {
    const filePath = getAuditLogPath(userId);
    const data = await fs.readFile(filePath, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }
    logger.error(`[Analytics] Failed to load audit log for user ${userId}:`, error.message);
    return [];
  }
}

/**
 * Load trip data for a user
 * @param {string} userId - User ID
 * @returns {Promise<Object>} Trip data map
 */
async function loadTripData(userId) {
  try {
    const filePath = getTripDataPath(userId);
    const data = await fs.readFile(filePath, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {};
    }
    logger.error(`[Analytics] Failed to load trip data for user ${userId}:`, error.message);
    return {};
  }
}

/**
 * Filter log entries by time range
 * @param {Array} logs - Log entries
 * @param {number} days - Number of days to include
 * @returns {Array} Filtered entries
 */
function filterByDays(logs, days) {
  const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);
  return logs.filter(log => log.timestamp >= cutoff);
}

/**
 * Filter log entries by autopilot type
 * @param {Array} logs - Log entries
 * @param {string|Array} types - Autopilot type(s) to filter
 * @returns {Array} Filtered entries
 */
function filterByType(logs, types) {
  const typeArray = Array.isArray(types) ? types : [types];
  return logs.filter(log => typeArray.includes(log.autopilot));
}

/**
 * Calculate weighted average price from purchase logs
 * @param {Array} purchases - Purchase log entries
 * @returns {number} Weighted average price
 */
function calculateWeightedAverage(purchases) {
  if (!purchases.length) return 0;

  let totalAmount = 0;
  let totalCost = 0;

  purchases.forEach(p => {
    const amount = p.details?.amount || 0;
    const cost = p.details?.totalCost || 0;
    totalAmount += amount;
    totalCost += cost;
  });

  return totalAmount > 0 ? totalCost / totalAmount : 0;
}

/**
 * Get weekly summary for a user
 * @param {string} userId - User ID
 * @param {number} weeks - Number of weeks (default 1)
 * @returns {Promise<Object>} Weekly summary
 */
async function getWeeklySummary(userId, weeks = 1) {
  const logs = await loadAuditLog(userId);
  const days = weeks * 7;
  const filtered = filterByDays(logs, days);

  // Departures
  const departures = filterByType(filtered, ['Auto-Depart', 'Manual Depart']);
  let totalRevenue = 0;
  let totalTrips = 0;
  let totalFuelUsed = 0;
  let totalCO2Used = 0;
  let totalHarborFees = 0;
  let totalContribution = 0;

  departures.forEach(log => {
    if (log.status === 'SUCCESS') {
      totalRevenue += log.details?.totalRevenue || 0;
      totalTrips += log.details?.vesselCount || 0;
      totalFuelUsed += log.details?.totalFuelUsed || 0;
      totalCO2Used += log.details?.totalCO2Used || 0;
      totalHarborFees += log.details?.totalHarborFees || 0;
      totalContribution += log.details?.contributionGainedTotal || 0;
    }
  });

  // Fuel purchases
  const fuelPurchases = filterByType(filtered, ['Auto-Fuel', 'Manual Fuel Purchase']);
  let fuelCost = 0;
  let fuelPurchased = 0;
  fuelPurchases.forEach(log => {
    if (log.status === 'SUCCESS') {
      fuelCost += log.details?.totalCost || 0;
      fuelPurchased += log.details?.amount || 0;
    }
  });

  // CO2 purchases
  const co2Purchases = filterByType(filtered, ['Auto-CO2', 'Manual CO2 Purchase']);
  let co2Cost = 0;
  let co2Purchased = 0;
  co2Purchases.forEach(log => {
    if (log.status === 'SUCCESS') {
      co2Cost += log.details?.totalCost || 0;
      co2Purchased += log.details?.amount || 0;
    }
  });

  // Repairs
  const repairs = filterByType(filtered, ['Auto-Repair', 'Auto-Drydock', 'Manual Repair', 'Manual Drydock']);
  let repairCost = 0;
  let repairCount = 0;
  repairs.forEach(log => {
    if (log.status === 'SUCCESS') {
      repairCost += log.details?.totalCost || log.details?.cost || 0;
      repairCount += log.details?.vesselCount || 1;
    }
  });

  // Marketing
  const marketing = filterByType(filtered, ['Auto-Marketing', 'Auto-Reputation', 'Manual Marketing']);
  let marketingCost = 0;
  marketing.forEach(log => {
    if (log.status === 'SUCCESS') {
      marketingCost += log.details?.totalCost || log.details?.cost || 0;
    }
  });

  // Stock transactions
  const stocks = filterByType(filtered, ['Manual Stock Purchase', 'Manual Stock Sale']);
  let stockPurchases = 0;
  let stockSales = 0;
  stocks.forEach(log => {
    if (log.status === 'SUCCESS') {
      if (log.autopilot.includes('Purchase')) {
        stockPurchases += log.details?.total_cost || 0;
      } else {
        stockSales += log.details?.total_revenue || 0;
      }
    }
  });

  // Calculate totals
  const totalExpenses = fuelCost + co2Cost + repairCost + marketingCost + totalHarborFees + stockPurchases;
  const totalIncome = totalRevenue + stockSales;
  const netProfit = totalIncome - totalExpenses;
  const profitMargin = totalIncome > 0 ? (netProfit / totalIncome) * 100 : 0;

  // Calculate averages
  const avgFuelPrice = calculateWeightedAverage(fuelPurchases.filter(p => p.status === 'SUCCESS'));
  const avgCO2Price = calculateWeightedAverage(co2Purchases.filter(p => p.status === 'SUCCESS'));

  return {
    period: {
      days,
      weeks,
      from: Date.now() - (days * 24 * 60 * 60 * 1000),
      to: Date.now()
    },
    income: {
      total: totalIncome,
      revenue: totalRevenue,
      stockSales
    },
    expenses: {
      total: totalExpenses,
      fuel: fuelCost,
      co2: co2Cost,
      repairs: repairCost,
      marketing: marketingCost,
      harborFees: totalHarborFees,
      stockPurchases
    },
    profit: {
      net: netProfit,
      margin: profitMargin
    },
    operations: {
      trips: totalTrips,
      fuelUsed: totalFuelUsed,
      co2Used: totalCO2Used,
      fuelPurchased,
      co2Purchased,
      repairCount,
      contribution: totalContribution
    },
    averages: {
      fuelPrice: avgFuelPrice,
      co2Price: avgCO2Price,
      revenuePerTrip: totalTrips > 0 ? totalRevenue / totalTrips : 0
    }
  };
}

/**
 * Get vessel performance metrics
 * @param {string} userId - User ID
 * @param {number} days - Number of days to analyze (default 30)
 * @returns {Promise<Array>} Vessel performance data
 */
async function getVesselPerformance(userId, days = 30) {
  const logs = await loadAuditLog(userId);
  const filtered = filterByDays(logs, days);
  const departures = filterByType(filtered, ['Auto-Depart', 'Manual Depart']);

  // Aggregate by vessel
  const vesselMap = new Map();

  departures.forEach(log => {
    if (log.status !== 'SUCCESS') return;

    const vessels = log.details?.departedVessels || log.details?.vessels || [];
    vessels.forEach(v => {
      const id = v.vesselId || v.vessel_id;
      if (!id) return;

      if (!vesselMap.has(id)) {
        vesselMap.set(id, {
          vesselId: id,
          name: v.name || v.vesselName || `Vessel ${id}`,
          trips: 0,
          totalRevenue: 0,
          totalFuelUsed: 0,
          totalCO2Used: 0,
          totalHarborFees: 0,
          totalContribution: 0,
          totalDistance: 0,
          utilizationSum: 0,
          routes: new Map()
        });
      }

      const vessel = vesselMap.get(id);
      vessel.trips++;
      vessel.totalRevenue += v.income || 0;
      vessel.totalFuelUsed += v.fuelUsed || 0;
      vessel.totalCO2Used += v.co2Used || 0;
      vessel.totalHarborFees += Math.abs(v.harborFee || 0);
      vessel.totalContribution += v.contributionGained || 0;
      vessel.totalDistance += v.distance || 0;
      vessel.utilizationSum += v.utilization || 0;

      // Track routes
      const routeKey = `${v.origin}<>${v.destination}`;
      if (v.origin && v.destination) {
        const current = vessel.routes.get(routeKey);
        vessel.routes.set(routeKey, current ? current + 1 : 1);
      }
    });
  });

  // Calculate averages and convert to array
  const results = [];
  vesselMap.forEach((vessel, id) => {
    const avgUtilization = vessel.trips > 0 ? vessel.utilizationSum / vessel.trips : 0;
    const avgRevenuePerTrip = vessel.trips > 0 ? vessel.totalRevenue / vessel.trips : 0;
    const fuelEfficiency = vessel.totalFuelUsed > 0 ? vessel.totalDistance / vessel.totalFuelUsed : 0;

    // Find most used route
    let primaryRoute = null;
    let maxRouteTrips = 0;
    vessel.routes.forEach((count, route) => {
      if (count > maxRouteTrips) {
        maxRouteTrips = count;
        primaryRoute = route;
      }
    });

    results.push({
      vesselId: id,
      name: vessel.name,
      trips: vessel.trips,
      totalRevenue: vessel.totalRevenue,
      totalFuelUsed: vessel.totalFuelUsed,
      totalCO2Used: vessel.totalCO2Used,
      totalHarborFees: vessel.totalHarborFees,
      totalContribution: vessel.totalContribution,
      totalDistance: vessel.totalDistance,
      avgUtilization: avgUtilization * 100,
      avgRevenuePerTrip,
      fuelEfficiency,
      primaryRoute: formatRouteDisplay(primaryRoute),
      routeCount: vessel.routes.size
    });
  });

  // Sort by revenue descending
  results.sort((a, b) => b.totalRevenue - a.totalRevenue);

  return results;
}

/**
 * Get route profitability analysis
 * @param {string} userId - User ID
 * @param {number} days - Number of days to analyze (default 30)
 * @returns {Promise<Array>} Route profitability data
 */
async function getRouteProfitability(userId, days = 30) {
  const logs = await loadAuditLog(userId);
  const filtered = filterByDays(logs, days);
  const departures = filterByType(filtered, ['Auto-Depart', 'Manual Depart']);

  // Aggregate by route
  const routeMap = new Map();

  departures.forEach(log => {
    if (log.status !== 'SUCCESS') return;

    const vessels = log.details?.departedVessels || log.details?.vessels || [];
    vessels.forEach(v => {
      const origin = v.origin || '';
      const destination = v.destination || '';
      if (!origin || !destination) return;

      const routeKey = `${origin}<>${destination}`;

      if (!routeMap.has(routeKey)) {
        routeMap.set(routeKey, {
          route: routeKey,
          origin,
          destination,
          trips: 0,
          totalRevenue: 0,
          totalHarborFees: 0,
          totalFuelUsed: 0,
          totalDistance: 0,
          vessels: new Set()
        });
      }

      const route = routeMap.get(routeKey);
      route.trips++;
      route.totalRevenue += v.income || 0;
      route.totalHarborFees += Math.abs(v.harborFee || 0);
      route.totalFuelUsed += v.fuelUsed || 0;
      route.totalDistance += v.distance || 0;
      route.vessels.add(v.vesselId || v.vessel_id);
    });
  });

  // Calculate metrics and convert to array
  const results = [];
  routeMap.forEach((route) => {
    const avgRevenuePerTrip = route.trips > 0 ? route.totalRevenue / route.trips : 0;
    const avgHarborFee = route.trips > 0 ? route.totalHarborFees / route.trips : 0;
    const harborFeePercent = route.totalRevenue > 0 ? (route.totalHarborFees / route.totalRevenue) * 100 : 0;
    const revenuePerKm = route.totalDistance > 0 ? route.totalRevenue / route.totalDistance : 0;

    results.push({
      route: route.route,
      origin: route.origin,
      destination: route.destination,
      trips: route.trips,
      totalRevenue: route.totalRevenue,
      totalHarborFees: route.totalHarborFees,
      totalFuelUsed: route.totalFuelUsed,
      totalDistance: route.totalDistance,
      avgRevenuePerTrip,
      avgHarborFee,
      harborFeePercent,
      revenuePerKm,
      vesselCount: route.vessels.size
    });
  });

  // Sort by total revenue descending
  results.sort((a, b) => b.totalRevenue - a.totalRevenue);

  return results;
}

/**
 * Get fuel and CO2 purchase analysis
 * @param {string} userId - User ID
 * @param {number} days - Number of days to analyze (default 30)
 * @returns {Promise<Object>} Purchase analysis
 */
async function getPurchaseAnalysis(userId, days = 30) {
  const logs = await loadAuditLog(userId);
  const filtered = filterByDays(logs, days);

  // Fuel purchases
  const fuelPurchases = filterByType(filtered, ['Auto-Fuel', 'Manual Fuel Purchase'])
    .filter(log => log.status === 'SUCCESS');

  const fuelAnalysis = {
    totalPurchases: fuelPurchases.length,
    totalAmount: 0,
    totalCost: 0,
    avgPrice: 0,
    minPrice: Infinity,
    maxPrice: 0,
    priceHistory: []
  };

  fuelPurchases.forEach(log => {
    const amount = log.details?.amount || 0;
    const price = log.details?.price || 0;
    const cost = log.details?.totalCost || 0;

    fuelAnalysis.totalAmount += amount;
    fuelAnalysis.totalCost += cost;
    if (price > 0) {
      fuelAnalysis.minPrice = Math.min(fuelAnalysis.minPrice, price);
      fuelAnalysis.maxPrice = Math.max(fuelAnalysis.maxPrice, price);
      fuelAnalysis.priceHistory.push({
        timestamp: log.timestamp,
        price,
        amount
      });
    }
  });

  fuelAnalysis.avgPrice = fuelAnalysis.totalAmount > 0
    ? fuelAnalysis.totalCost / fuelAnalysis.totalAmount
    : 0;
  if (fuelAnalysis.minPrice === Infinity) fuelAnalysis.minPrice = 0;

  // CO2 purchases
  const co2Purchases = filterByType(filtered, ['Auto-CO2', 'Manual CO2 Purchase'])
    .filter(log => log.status === 'SUCCESS');

  const co2Analysis = {
    totalPurchases: co2Purchases.length,
    totalAmount: 0,
    totalCost: 0,
    avgPrice: 0,
    minPrice: Infinity,
    maxPrice: 0,
    priceHistory: []
  };

  co2Purchases.forEach(log => {
    const amount = log.details?.amount || 0;
    const price = log.details?.price || 0;
    const cost = log.details?.totalCost || 0;

    co2Analysis.totalAmount += amount;
    co2Analysis.totalCost += cost;
    if (price > 0) {
      co2Analysis.minPrice = Math.min(co2Analysis.minPrice, price);
      co2Analysis.maxPrice = Math.max(co2Analysis.maxPrice, price);
      co2Analysis.priceHistory.push({
        timestamp: log.timestamp,
        price,
        amount
      });
    }
  });

  co2Analysis.avgPrice = co2Analysis.totalAmount > 0
    ? co2Analysis.totalCost / co2Analysis.totalAmount
    : 0;
  if (co2Analysis.minPrice === Infinity) co2Analysis.minPrice = 0;

  return {
    fuel: fuelAnalysis,
    co2: co2Analysis
  };
}

/**
 * Get harbor fee analysis by destination
 * @param {string} userId - User ID
 * @param {number} days - Number of days to analyze (default 30)
 * @returns {Promise<Array>} Harbor fee analysis by port
 */
async function getHarborFeeAnalysis(userId, days = 30) {
  const logs = await loadAuditLog(userId);
  const filtered = filterByDays(logs, days);
  const departures = filterByType(filtered, ['Auto-Depart', 'Manual Depart']);

  // Aggregate by destination
  const portMap = new Map();

  departures.forEach(log => {
    if (log.status !== 'SUCCESS') return;

    const vessels = log.details?.departedVessels || log.details?.vessels || [];
    vessels.forEach(v => {
      const destination = v.destination || '';
      if (!destination) return;

      if (!portMap.has(destination)) {
        portMap.set(destination, {
          port: destination,
          trips: 0,
          totalFees: 0,
          totalRevenue: 0
        });
      }

      const port = portMap.get(destination);
      port.trips++;
      port.totalFees += Math.abs(v.harborFee || 0);
      port.totalRevenue += v.income || 0;
    });
  });

  // Calculate metrics and convert to array
  const results = [];
  portMap.forEach((port) => {
    const avgFee = port.trips > 0 ? port.totalFees / port.trips : 0;
    const feePercent = port.totalRevenue > 0 ? (port.totalFees / port.totalRevenue) * 100 : 0;

    results.push({
      port: port.port,
      trips: port.trips,
      totalFees: port.totalFees,
      totalRevenue: port.totalRevenue,
      avgFee,
      feePercent
    });
  });

  // Sort by total fees descending
  results.sort((a, b) => b.totalFees - a.totalFees);

  return results;
}

/**
 * Get contribution analysis
 * @param {string} userId - User ID
 * @param {number} days - Number of days to analyze (default 30)
 * @returns {Promise<Object>} Contribution analysis
 */
async function getContributionAnalysis(userId, days = 30) {
  const logs = await loadAuditLog(userId);
  const filtered = filterByDays(logs, days);
  const departures = filterByType(filtered, ['Auto-Depart', 'Manual Depart']);

  let totalContribution = 0;
  let totalTrips = 0;
  let totalRevenue = 0;
  const vesselContribution = new Map();

  departures.forEach(log => {
    if (log.status !== 'SUCCESS') return;

    const vessels = log.details?.departedVessels || log.details?.vessels || [];
    vessels.forEach(v => {
      const id = v.vesselId || v.vessel_id;
      const contribution = v.contributionGained || 0;
      const revenue = v.income || 0;

      totalContribution += contribution;
      totalTrips++;
      totalRevenue += revenue;

      if (id) {
        if (!vesselContribution.has(id)) {
          vesselContribution.set(id, {
            vesselId: id,
            name: v.name || v.vesselName || `Vessel ${id}`,
            trips: 0,
            totalContribution: 0,
            totalRevenue: 0
          });
        }

        const vessel = vesselContribution.get(id);
        vessel.trips++;
        vessel.totalContribution += contribution;
        vessel.totalRevenue += revenue;
      }
    });
  });

  // Convert to array and sort
  const byVessel = [];
  vesselContribution.forEach((vessel) => {
    const avgPerTrip = vessel.trips > 0 ? vessel.totalContribution / vessel.trips : 0;
    const efficiency = vessel.totalRevenue > 0 ? vessel.totalContribution / (vessel.totalRevenue / 1000000) : 0;

    byVessel.push({
      ...vessel,
      avgPerTrip,
      efficiency
    });
  });

  byVessel.sort((a, b) => b.totalContribution - a.totalContribution);

  return {
    total: totalContribution,
    trips: totalTrips,
    avgPerTrip: totalTrips > 0 ? totalContribution / totalTrips : 0,
    efficiency: totalRevenue > 0 ? totalContribution / (totalRevenue / 1000000) : 0,
    byVessel
  };
}

/**
 * Get daily revenue trend
 * @param {string} userId - User ID
 * @param {number} days - Number of days (default 30)
 * @returns {Promise<Array>} Daily revenue data
 */
async function getDailyRevenueTrend(userId, days = 30) {
  const logs = await loadAuditLog(userId);
  const filtered = filterByDays(logs, days);
  const departures = filterByType(filtered, ['Auto-Depart', 'Manual Depart']);

  // Group by day
  const dailyMap = new Map();

  departures.forEach(log => {
    if (log.status !== 'SUCCESS') return;

    const date = new Date(log.timestamp);
    const dayKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

    if (!dailyMap.has(dayKey)) {
      dailyMap.set(dayKey, {
        date: dayKey,
        timestamp: new Date(dayKey).getTime(),
        revenue: 0,
        trips: 0,
        expenses: 0
      });
    }

    const day = dailyMap.get(dayKey);
    day.revenue += log.details?.totalRevenue || 0;
    day.trips += log.details?.vesselCount || 0;
  });

  // Add expense data
  const expenses = filterByType(filtered, ['Auto-Fuel', 'Auto-CO2', 'Auto-Repair', 'Auto-Drydock', 'Manual Fuel Purchase', 'Manual CO2 Purchase']);
  expenses.forEach(log => {
    if (log.status !== 'SUCCESS') return;

    const date = new Date(log.timestamp);
    const dayKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

    if (!dailyMap.has(dayKey)) {
      dailyMap.set(dayKey, {
        date: dayKey,
        timestamp: new Date(dayKey).getTime(),
        revenue: 0,
        trips: 0,
        expenses: 0
      });
    }

    const day = dailyMap.get(dayKey);
    day.expenses += log.details?.totalCost || log.details?.cost || 0;
  });

  // Convert to array and sort by date
  const results = Array.from(dailyMap.values());
  results.sort((a, b) => a.timestamp - b.timestamp);

  // Calculate profit for each day
  results.forEach(day => {
    day.profit = day.revenue - day.expenses;
  });

  return results;
}

/**
 * Get route contribution analysis
 * @param {string} userId - User ID
 * @param {number} days - Number of days to analyze (default 30)
 * @returns {Promise<Array>} Route contribution data
 */
async function getRouteContribution(userId, days = 30) {
  const logs = await loadAuditLog(userId);
  const filtered = filterByDays(logs, days);
  const departures = filterByType(filtered, ['Auto-Depart', 'Manual Depart']);

  // Aggregate by route
  const routeMap = new Map();

  departures.forEach(log => {
    if (log.status !== 'SUCCESS') return;

    const vessels = log.details?.departedVessels || log.details?.vessels || [];
    vessels.forEach(v => {
      const origin = v.origin || '';
      const destination = v.destination || '';
      if (!origin || !destination) return;

      const routeKey = `${origin}<>${destination}`;

      if (!routeMap.has(routeKey)) {
        routeMap.set(routeKey, {
          route: routeKey,
          origin,
          destination,
          trips: 0,
          totalContribution: 0,
          totalRevenue: 0,
          totalDistance: 0,
          vessels: new Set()
        });
      }

      const route = routeMap.get(routeKey);
      route.trips++;
      route.totalContribution += v.contributionGained || 0;
      route.totalRevenue += v.income || 0;
      route.totalDistance += v.distance || 0;
      route.vessels.add(v.vesselId || v.vessel_id);
    });
  });

  // Calculate metrics and convert to array
  const results = [];
  routeMap.forEach((route) => {
    const avgContribPerTrip = route.trips > 0 ? route.totalContribution / route.trips : 0;
    const contribPerKm = route.totalDistance > 0 ? route.totalContribution / (route.totalDistance / 1000) : 0;
    const contribPer100kRevenue = route.totalRevenue > 0 ? (route.totalContribution / route.totalRevenue) * 100000 : 0;

    results.push({
      route: route.route,
      origin: route.origin,
      destination: route.destination,
      trips: route.trips,
      totalContribution: route.totalContribution,
      totalRevenue: route.totalRevenue,
      totalDistance: route.totalDistance,
      avgContribPerTrip,
      contribPerKm,
      contribPer100kRevenue,
      vesselCount: route.vessels.size
    });
  });

  // Sort by total contribution descending
  results.sort((a, b) => b.totalContribution - a.totalContribution);

  return results;
}

/**
 * Get detailed expense breakdown (all log categories)
 * @param {string} userId - User ID
 * @param {number} days - Number of days to analyze
 * @returns {Promise<Object>} Detailed expense breakdown
 */
async function getDetailedExpenses(userId, days = 30) {
  const logs = await loadAuditLog(userId);
  const filtered = filterByDays(logs, days);

  const expenses = {
    fuel: { total: 0, count: 0, auto: 0, manual: 0, entries: [] },
    co2: { total: 0, count: 0, auto: 0, manual: 0, entries: [] },
    repairs: { total: 0, count: 0, auto: 0, manual: 0, entries: [] },
    drydock: { total: 0, count: 0, auto: 0, manual: 0, entries: [] },
    campaigns: { total: 0, count: 0, auto: 0, manual: 0, entries: [] },
    anchors: { total: 0, count: 0, auto: 0, manual: 0, entries: [] },
    harborFees: { total: 0, count: 0, entries: [] },
    hijacking: { ransomPaid: 0, negotiated: 0, count: 0, entries: [] },
    vesselPurchases: { total: 0, count: 0, entries: [] },
    vesselSales: { total: 0, count: 0, entries: [] },
    // Game-log only categories (merged from getMergedSummary)
    salary: { total: 0, count: 0, auto: 0, manual: 0 },
    guards: { total: 0, count: 0, auto: 0, manual: 0 },
    routeFees: { total: 0, count: 0, auto: 0, manual: 0 },
    pirateRaid: { total: 0, count: 0, auto: 0, manual: 0 },
    stockPurchases: { total: 0, count: 0, auto: 0, manual: 0 },
    allianceContribution: { total: 0, count: 0, auto: 0, manual: 0 },
    vesselBuilding: { total: 0, count: 0, auto: 0, manual: 0 }
  };

  // Fuel
  filterByType(filtered, ['Auto-Fuel']).forEach(log => {
    if (log.status === 'SUCCESS') {
      expenses.fuel.total += log.details?.totalCost || 0;
      expenses.fuel.auto += log.details?.totalCost || 0;
      expenses.fuel.count++;
      expenses.fuel.entries.push({ timestamp: log.timestamp, amount: log.details?.amount, price: log.details?.price, cost: log.details?.totalCost, source: 'auto' });
    }
  });
  filterByType(filtered, ['Manual Fuel Purchase']).forEach(log => {
    if (log.status === 'SUCCESS') {
      expenses.fuel.total += log.details?.totalCost || 0;
      expenses.fuel.manual += log.details?.totalCost || 0;
      expenses.fuel.count++;
      expenses.fuel.entries.push({ timestamp: log.timestamp, amount: log.details?.amount, price: log.details?.price, cost: log.details?.totalCost, source: 'manual' });
    }
  });

  // CO2
  filterByType(filtered, ['Auto-CO2']).forEach(log => {
    if (log.status === 'SUCCESS') {
      expenses.co2.total += log.details?.totalCost || 0;
      expenses.co2.auto += log.details?.totalCost || 0;
      expenses.co2.count++;
      expenses.co2.entries.push({ timestamp: log.timestamp, amount: log.details?.amount, price: log.details?.price, cost: log.details?.totalCost, source: 'auto' });
    }
  });
  filterByType(filtered, ['Manual CO2 Purchase']).forEach(log => {
    if (log.status === 'SUCCESS') {
      expenses.co2.total += log.details?.totalCost || 0;
      expenses.co2.manual += log.details?.totalCost || 0;
      expenses.co2.count++;
      expenses.co2.entries.push({ timestamp: log.timestamp, amount: log.details?.amount, price: log.details?.price, cost: log.details?.totalCost, source: 'manual' });
    }
  });

  // Repairs
  filterByType(filtered, ['Auto-Repair']).forEach(log => {
    if (log.status === 'SUCCESS') {
      const cost = log.details?.totalCost || log.details?.cost || 0;
      expenses.repairs.total += cost;
      expenses.repairs.auto += cost;
      expenses.repairs.count += log.details?.vesselCount || 1;
      expenses.repairs.entries.push({ timestamp: log.timestamp, cost, vesselCount: log.details?.vesselCount || 1, source: 'auto' });
    }
  });
  filterByType(filtered, ['Manual Bulk Repair']).forEach(log => {
    if (log.status === 'SUCCESS') {
      const cost = log.details?.totalCost || log.details?.cost || 0;
      expenses.repairs.total += cost;
      expenses.repairs.manual += cost;
      expenses.repairs.count += log.details?.vesselCount || 1;
      expenses.repairs.entries.push({ timestamp: log.timestamp, cost, vesselCount: log.details?.vesselCount || 1, source: 'manual' });
    }
  });

  // Drydock
  filterByType(filtered, ['Auto-Drydock']).forEach(log => {
    if (log.status === 'SUCCESS') {
      const cost = log.details?.totalCost || log.details?.cost || 0;
      expenses.drydock.total += cost;
      expenses.drydock.auto += cost;
      expenses.drydock.count += log.details?.vesselCount || 1;
      expenses.drydock.entries.push({ timestamp: log.timestamp, cost, source: 'auto' });
    }
  });
  filterByType(filtered, ['Manual Bulk Drydock']).forEach(log => {
    if (log.status === 'SUCCESS') {
      const cost = log.details?.totalCost || log.details?.cost || 0;
      expenses.drydock.total += cost;
      expenses.drydock.manual += cost;
      expenses.drydock.count += log.details?.vesselCount || 1;
      expenses.drydock.entries.push({ timestamp: log.timestamp, cost, source: 'manual' });
    }
  });

  // Campaigns
  filterByType(filtered, ['Auto-Campaign']).forEach(log => {
    if (log.status === 'SUCCESS') {
      expenses.campaigns.total += log.details?.totalCost || 0;
      expenses.campaigns.auto += log.details?.totalCost || 0;
      expenses.campaigns.count += log.details?.campaignCount || 1;
      expenses.campaigns.entries.push({ timestamp: log.timestamp, cost: log.details?.totalCost, campaigns: log.details?.renewedCampaigns, source: 'auto' });
    }
  });
  filterByType(filtered, ['Campaign Activation']).forEach(log => {
    if (log.status === 'SUCCESS') {
      expenses.campaigns.total += log.details?.totalCost || log.details?.cost || 0;
      expenses.campaigns.manual += log.details?.totalCost || log.details?.cost || 0;
      expenses.campaigns.count++;
      expenses.campaigns.entries.push({ timestamp: log.timestamp, cost: log.details?.totalCost || log.details?.cost, source: 'manual' });
    }
  });

  // Anchors
  filterByType(filtered, ['Auto-Anchor']).forEach(log => {
    if (log.status === 'SUCCESS') {
      expenses.anchors.total += log.details?.totalCost || 0;
      expenses.anchors.auto += log.details?.totalCost || 0;
      expenses.anchors.count += log.details?.amount || 1;
      expenses.anchors.entries.push({ timestamp: log.timestamp, cost: log.details?.totalCost, amount: log.details?.amount, source: 'auto' });
    }
  });
  filterByType(filtered, ['Manual Anchor Purchase']).forEach(log => {
    if (log.status === 'SUCCESS') {
      expenses.anchors.total += log.details?.totalCost || 0;
      expenses.anchors.manual += log.details?.totalCost || 0;
      expenses.anchors.count += log.details?.amount || 1;
      expenses.anchors.entries.push({ timestamp: log.timestamp, cost: log.details?.totalCost, amount: log.details?.amount, source: 'manual' });
    }
  });

  // Harbor fees from departures
  filterByType(filtered, ['Auto-Depart', 'Manual Depart']).forEach(log => {
    if (log.status === 'SUCCESS') {
      expenses.harborFees.total += log.details?.totalHarborFees || 0;
      expenses.harborFees.count += log.details?.vesselCount || 0;
    }
  });

  // Hijacking
  filterByType(filtered, ['Manual Pay Ransom']).forEach(log => {
    if (log.status === 'SUCCESS') {
      expenses.hijacking.ransomPaid += log.details?.amount || log.details?.cost || 0;
      expenses.hijacking.count++;
      expenses.hijacking.entries.push({ timestamp: log.timestamp, type: 'ransom', amount: log.details?.amount || log.details?.cost });
    }
  });
  filterByType(filtered, ['Manual Negotiate Hijacking']).forEach(log => {
    if (log.status === 'SUCCESS') {
      expenses.hijacking.negotiated++;
      expenses.hijacking.entries.push({ timestamp: log.timestamp, type: 'negotiate' });
    }
  });

  // Vessel purchases
  filterByType(filtered, ['Manual Vessel Purchase']).forEach(log => {
    if (log.status === 'SUCCESS') {
      expenses.vesselPurchases.total += log.details?.total_cost || 0;
      expenses.vesselPurchases.count += log.details?.vessel_count || 1;
      expenses.vesselPurchases.entries.push({ timestamp: log.timestamp, cost: log.details?.total_cost, vessels: log.details?.vessels });
    }
  });

  // Vessel sales
  filterByType(filtered, ['Manual Vessel Sale']).forEach(log => {
    if (log.status === 'SUCCESS') {
      expenses.vesselSales.total += log.details?.total_revenue || log.details?.revenue || 0;
      expenses.vesselSales.count += log.details?.vessel_count || 1;
      expenses.vesselSales.entries.push({ timestamp: log.timestamp, revenue: log.details?.total_revenue || log.details?.revenue });
    }
  });

  // Merge game-log data - this is the authoritative source for totals
  // getMergedSummary now returns expenses with auto/manual breakdown for certain categories
  let gameGrandTotal = 0;
  try {
    const mergedSummary = await getMergedSummary(userId, days);
    if (mergedSummary && mergedSummary.expenses) {
      const gameExp = mergedSummary.expenses;

      // Helper to extract value from either number or {total, auto, manual} object
      const getValue = (val, prop = 'total') => {
        if (typeof val === 'number') return val;
        if (val && typeof val === 'object') return val[prop] || 0;
        return 0;
      };

      // Use game-log grand total as authoritative (same as Game Log tab)
      gameGrandTotal = gameExp.total || 0;

      // Merge game-log only categories (these don't have auto/manual from game log)
      expenses.salary.total = getValue(gameExp.salary);
      expenses.salary.auto = getValue(gameExp.salary);
      expenses.guards.total = getValue(gameExp.guards);
      expenses.guards.auto = getValue(gameExp.guards);
      expenses.routeFees.total = getValue(gameExp.routeFees);
      expenses.routeFees.auto = getValue(gameExp.routeFees);
      expenses.pirateRaid.total = getValue(gameExp.pirateRaid);
      expenses.pirateRaid.manual = getValue(gameExp.pirateRaid);
      expenses.stockPurchases.total = getValue(gameExp.stockPurchases);
      expenses.stockPurchases.manual = getValue(gameExp.stockPurchases);
      expenses.allianceContribution.total = getValue(gameExp.allianceContribution);
      expenses.allianceContribution.manual = getValue(gameExp.allianceContribution);
      expenses.vesselBuilding.total = getValue(gameExp.vesselBuilding);
      expenses.vesselBuilding.manual = getValue(gameExp.vesselBuilding);

      // Categories with auto/manual breakdown from getMergedSummary
      // Use the merged totals AND the auto/manual breakdown
      if (gameExp.fuel) {
        expenses.fuel.total = getValue(gameExp.fuel) || expenses.fuel.total;
        expenses.fuel.auto = getValue(gameExp.fuel, 'auto') || expenses.fuel.auto;
        expenses.fuel.manual = getValue(gameExp.fuel, 'manual') || expenses.fuel.manual;
      }
      if (gameExp.co2) {
        expenses.co2.total = getValue(gameExp.co2) || expenses.co2.total;
        expenses.co2.auto = getValue(gameExp.co2, 'auto') || expenses.co2.auto;
        expenses.co2.manual = getValue(gameExp.co2, 'manual') || expenses.co2.manual;
      }
      if (gameExp.repairs) {
        expenses.repairs.total = getValue(gameExp.repairs) || expenses.repairs.total;
        expenses.repairs.auto = getValue(gameExp.repairs, 'auto') || expenses.repairs.auto;
        expenses.repairs.manual = getValue(gameExp.repairs, 'manual') || expenses.repairs.manual;
      }
      if (gameExp.drydock) {
        expenses.drydock.total = getValue(gameExp.drydock) || expenses.drydock.total;
        expenses.drydock.auto = getValue(gameExp.drydock, 'auto') || expenses.drydock.auto;
        expenses.drydock.manual = getValue(gameExp.drydock, 'manual') || expenses.drydock.manual;
      }
      if (gameExp.marketing) {
        expenses.campaigns.total = getValue(gameExp.marketing) || expenses.campaigns.total;
        expenses.campaigns.auto = getValue(gameExp.marketing, 'auto') || expenses.campaigns.auto;
        expenses.campaigns.manual = getValue(gameExp.marketing, 'manual') || expenses.campaigns.manual;
      }
      if (gameExp.anchors) {
        expenses.anchors.total = getValue(gameExp.anchors) || expenses.anchors.total;
        expenses.anchors.auto = getValue(gameExp.anchors, 'auto') || expenses.anchors.auto;
        expenses.anchors.manual = getValue(gameExp.anchors, 'manual') || expenses.anchors.manual;
      }

      // Simple categories without auto/manual
      expenses.harborFees.total = getValue(gameExp.harborFees) || expenses.harborFees.total;
      expenses.hijacking.ransomPaid = getValue(gameExp.hijacking) || expenses.hijacking.ransomPaid;
      expenses.vesselPurchases.total = getValue(gameExp.vesselPurchases) || expenses.vesselPurchases.total;

      // Add any dynamic categories from game-log that we don't have predefined
      // Skip 'marketing' since it's already handled as 'campaigns' above
      const skipKeys = new Set(['total', 'marketing']);
      Object.keys(gameExp).forEach(key => {
        if (!skipKeys.has(key) && !expenses[key]) {
          const val = getValue(gameExp[key]);
          expenses[key] = { total: val, count: 0, auto: 0, manual: val };
        }
      });
    }
  } catch (err) {
    // If getMergedSummary fails, continue with local data only
    logger.warn('[Aggregator] Could not merge game-log data into detailedExpenses:', err.message);
  }

  // Use game-log grand total if available, otherwise calculate from all categories
  let grandTotal = gameGrandTotal;
  if (!grandTotal) {
    grandTotal = 0;
    Object.keys(expenses).forEach(key => {
      if (expenses[key] && typeof expenses[key].total === 'number') {
        grandTotal += expenses[key].total;
      } else if (key === 'hijacking' && expenses[key]) {
        grandTotal += expenses[key].ransomPaid || 0;
      }
    });
  }

  return {
    ...expenses,
    grandTotal,
    netVesselCost: expenses.vesselPurchases.total - expenses.vesselSales.total
  };
}

/**
 * Get all action types from the log (for filtering UI)
 * @param {string} userId - User ID
 * @returns {Promise<Array>} Unique action types
 */
async function getActionTypes(userId) {
  const logs = await loadAuditLog(userId);
  const types = [...new Set(logs.map(log => log.autopilot))].sort();
  return types;
}

/**
 * Get raw log entries with optional filtering
 * @param {string} userId - User ID
 * @param {number} days - Number of days
 * @param {Array} actions - Filter by action types (optional)
 * @param {string} status - Filter by status (optional)
 * @returns {Promise<Array>} Filtered log entries
 */
async function getFilteredLogs(userId, days = 30, actions = null, status = null) {
  const logs = await loadAuditLog(userId);
  let filtered = filterByDays(logs, days);

  if (actions && actions.length > 0) {
    filtered = filterByType(filtered, actions);
  }

  if (status) {
    filtered = filtered.filter(log => log.status === status);
  }

  // Sort by timestamp descending (newest first)
  filtered.sort((a, b) => b.timestamp - a.timestamp);

  return filtered;
}

/**
 * Map game transaction context to expense category
 * @param {string} context - Game API transaction context
 * @returns {string} Category name
 */
function mapContextToCategory(context) {
  const mapping = {
    // Purchases
    fuel_purchased: 'fuel',
    co2_emission_quota: 'co2',
    // Maintenance
    bulk_wear_maintenance: 'repairs',
    bulk_vessel_major_service: 'drydock',
    vessel_major_service: 'drydock',
    // Operations
    marketing_campaign_activation: 'marketing',
    salary_payment: 'salary',
    harbor_fee_on_depart: 'harborFees',
    guard_payment_on_depart: 'guards',
    route_fee_on_creating: 'routeFees',
    anchor_points: 'anchors',
    // Vessels
    buy_vessel: 'vesselPurchases',
    Vessel_build_Purchase: 'vesselBuilding',
    sell_vessel: 'vesselSales',
    Sold_vessel_in_port: 'vesselSales',
    // Revenue
    vessels_departed: 'revenue',
    // Stocks
    purchase_stock: 'stockPurchases',
    sell_stock: 'stockSales',
    Increase_shares: 'stockDividends',
    // Losses
    hijacking: 'hijacking',
    pirate_raid: 'pirateRaid',
    // Alliance
    alliance_contribution: 'allianceContribution',
    // Bonuses
    daily_bonus: 'bonus',
    ad_video: 'adBonus'
  };
  return mapping[context] || context;
}

/**
 * Map game transaction context to audit log autopilot types
 * Returns the Auto- type that would match this game context
 * @param {string} context - Game API transaction context
 * @returns {string|null} Audit log Auto- type or null if no autopilot equivalent
 */
function mapContextToAutopilotType(context) {
  const mapping = {
    fuel_purchased: 'Auto-Fuel',
    co2_emission_quota: 'Auto-CO2',
    bulk_wear_maintenance: 'Auto-Repair',
    bulk_vessel_major_service: 'Auto-Drydock',
    vessel_major_service: 'Auto-Drydock',
    marketing_campaign_activation: 'Auto-Campaign',
    anchor_points: 'Auto-Anchor',
    vessels_departed: 'Auto-Depart'
  };
  return mapping[context];
}

/**
 * Check if a game transaction was triggered by autopilot
 * Matches game transaction timestamp with audit log entries
 * @param {Object} gameTransaction - Game transaction with time (unix timestamp)
 * @param {Array} auditLogs - Filtered audit log entries
 * @param {string} autopilotType - The Auto- type to look for (e.g. 'Auto-Fuel')
 * @returns {boolean} True if matching autopilot entry found
 */
function isAutopilotTransaction(gameTransaction, auditLogs, autopilotType) {
  if (!autopilotType) return false;

  const gameTimeMs = gameTransaction.time * 1000;
  const tolerance = 120000; // 2 minute tolerance for matching

  return auditLogs.some(log => {
    if (log.autopilot !== autopilotType) return false;
    if (log.status !== 'SUCCESS') return false;

    const timeDiff = Math.abs(log.timestamp - gameTimeMs);
    return timeDiff <= tolerance;
  });
}

/**
 * Get merged summary combining game transactions with local autopilot data
 * Game transactions are the PRIMARY source for financial data (most complete)
 * Local autopilot logs provide additional detail (vessel names, routes, contribution per vessel)
 *
 * @param {string} userId - User ID
 * @param {number} days - Number of days to analyze
 * @returns {Promise<Object>} Merged analytics summary
 */
async function getMergedSummary(userId, days = 7) {
  // Get game transactions (primary financial source)
  const gameTransactions = await transactionStore.getTransactionsByDays(userId, days);

  // Get local autopilot logs (for detail enrichment)
  const localLogs = await loadAuditLog(userId);
  const filteredLogs = filterByDays(localLogs, days);

  // Aggregate game transactions by category
  const income = {
    total: 0,
    revenue: 0,
    stockSales: 0,
    stockDividends: 0,
    vesselSales: 0,
    bonus: 0,
    adBonus: 0
  };

  // Expenses with auto/manual breakdown
  // Structure: { total, auto, manual } for categories that can be autopilot
  const expenses = {
    total: 0,
    fuel: { total: 0, auto: 0, manual: 0 },
    co2: { total: 0, auto: 0, manual: 0 },
    repairs: { total: 0, auto: 0, manual: 0 },
    drydock: { total: 0, auto: 0, manual: 0 },
    marketing: { total: 0, auto: 0, manual: 0 },
    salary: 0,
    harborFees: 0,
    guards: 0,
    routeFees: 0,
    anchors: { total: 0, auto: 0, manual: 0 },
    stockPurchases: 0,
    vesselPurchases: 0,
    vesselBuilding: 0,
    hijacking: 0,
    pirateRaid: 0,
    allianceContribution: 0
  };

  // Categories that can have auto/manual breakdown
  const autoCategories = new Set(['fuel', 'co2', 'repairs', 'drydock', 'marketing', 'anchors']);

  // Process game transactions with auto/manual matching
  gameTransactions.forEach(t => {
    const category = mapContextToCategory(t.context);
    const autopilotType = mapContextToAutopilotType(t.context);

    if (t.cash >= 0) {
      // Income
      income.total += t.cash;
      if (income[category] !== undefined) {
        income[category] += t.cash;
      } else {
        // Dynamic category - add it to income object
        income[category] = t.cash;
      }
    } else {
      // Expense (absolute value)
      const amount = Math.abs(t.cash);
      expenses.total += amount;

      // Check if this was an autopilot transaction by matching with audit log
      const isAuto = isAutopilotTransaction(t, filteredLogs, autopilotType);

      if (autoCategories.has(category)) {
        // Category supports auto/manual breakdown
        if (!expenses[category]) {
          expenses[category] = { total: 0, auto: 0, manual: 0 };
        }
        expenses[category].total += amount;
        if (isAuto) {
          expenses[category].auto += amount;
        } else {
          expenses[category].manual += amount;
        }
      } else if (expenses[category] !== undefined) {
        // Simple category (just a number)
        if (typeof expenses[category] === 'number') {
          expenses[category] += amount;
        } else {
          expenses[category].total += amount;
        }
      } else {
        // Dynamic category - add it to expenses object as simple number
        expenses[category] = amount;
      }
    }
  });

  // Net vessel cost (purchases - sales from game data)
  const vesselSalesTotal = gameTransactions
    .filter(t => t.context === 'sell_vessel' || t.context === 'Sold_vessel_in_port')
    .reduce((sum, t) => sum + t.cash, 0);

  // Get local log details for enrichment
  const departures = filterByType(filteredLogs, ['Auto-Depart', 'Manual Depart']);

  // Operations data from local logs (game API doesn't provide this detail)
  let totalTrips = 0;
  let totalFuelUsed = 0;
  let totalCO2Used = 0;
  let totalContribution = 0;
  let totalDistance = 0;

  departures.forEach(log => {
    if (log.status === 'SUCCESS') {
      totalTrips += log.details?.vesselCount || 0;
      totalFuelUsed += log.details?.totalFuelUsed || 0;
      totalCO2Used += log.details?.totalCO2Used || 0;
      totalContribution += log.details?.contributionGainedTotal || 0;

      // Sum distance from vessels
      const vessels = log.details?.departedVessels || log.details?.vessels || [];
      vessels.forEach(v => {
        totalDistance += v.distance || 0;
      });
    }
  });

  // Calculate profit
  const netProfit = income.total - expenses.total;
  const profitMargin = income.total > 0 ? (netProfit / income.total) * 100 : 0;

  // Calculate avg fuel price from local purchase logs
  const fuelPurchases = filterByType(filteredLogs, ['Auto-Fuel', 'Manual Fuel Purchase'])
    .filter(p => p.status === 'SUCCESS');
  const avgFuelPrice = calculateWeightedAverage(fuelPurchases);

  // Build daily breakdown from game transactions
  const dailyMap = new Map();
  gameTransactions.forEach(t => {
    const date = new Date(t.time * 1000).toISOString().split('T')[0];
    if (!dailyMap.has(date)) {
      dailyMap.set(date, {
        date,
        income: 0,
        expenses: 0,
        net: 0,
        byContext: {}
      });
    }
    const day = dailyMap.get(date);
    if (t.cash >= 0) {
      day.income += t.cash;
    } else {
      day.expenses += Math.abs(t.cash);
    }
    day.net = day.income - day.expenses;

    if (!day.byContext[t.context]) {
      day.byContext[t.context] = 0;
    }
    day.byContext[t.context] += t.cash;
  });

  const dailyBreakdown = Array.from(dailyMap.values()).sort((a, b) => a.date.localeCompare(b.date));

  return {
    source: 'merged',
    period: {
      days,
      from: Date.now() - (days * 24 * 60 * 60 * 1000),
      to: Date.now()
    },
    income,
    expenses,
    profit: {
      net: netProfit,
      margin: profitMargin
    },
    operations: {
      trips: totalTrips,
      fuelUsed: totalFuelUsed,
      co2Used: totalCO2Used,
      contribution: totalContribution,
      distance: totalDistance
    },
    averages: {
      fuelPrice: avgFuelPrice
    },
    vesselNetCost: (typeof expenses.vesselPurchases === 'number' ? expenses.vesselPurchases : expenses.vesselPurchases.total) - vesselSalesTotal,
    transactionCount: gameTransactions.length,
    dailyBreakdown,
    // Include raw context totals for detailed breakdown
    byContext: gameTransactions.reduce((acc, t) => {
      if (!acc[t.context]) {
        acc[t.context] = { income: 0, expenses: 0, count: 0 };
      }
      acc[t.context].count++;
      if (t.cash >= 0) {
        acc[t.context].income += t.cash;
      } else {
        acc[t.context].expenses += Math.abs(t.cash);
      }
      return acc;
    }, {})
  };
}

/**
 * Get vessel performance with contribution from merged data (local + game history)
 * @param {string} userId - User ID
 * @param {number} days - Number of days to analyze
 * @returns {Promise<Array>} Vessel performance with contribution
 */
async function getVesselPerformanceWithContribution(userId, days = 30) {
  // Use merged departures (local logs + game import)
  const vesselPerf = await getVesselPerformanceMerged(userId, days);

  // Ensure contribution field is properly named
  return vesselPerf.map(v => ({
    ...v,
    contribution: v.totalContribution
  }));
}

/**
 * Get route profitability with contribution from merged data (local + game history)
 * @param {string} userId - User ID
 * @param {number} days - Number of days to analyze
 * @returns {Promise<Array>} Route profitability with contribution
 */
async function getRouteProfitabilityWithContribution(userId, days = 30) {
  // Use merged departures (local logs + game import)
  const routeProf = await getRouteProfitabilityMerged(userId, days);

  // Ensure contribution field is properly named
  return routeProf.map(r => ({
    ...r,
    contribution: r.totalContribution || 0,
    avgContribPerTrip: r.totalContribution && r.trips ? r.totalContribution / r.trips : 0
  }));
}

/**
 * Get merged departure logs combining local autopilot logs with Game API history
 * Strategy:
 * - Before first local log: use only Game Departure data
 * - After first local log: use both, deduplicate by vessel+timestamp (within 5 min window)
 *
 * @param {string} userId - User ID
 * @param {number} days - Number of days to analyze
 * @returns {Promise<Array>} Merged departure entries
 */
async function getMergedDepartures(userId, days) {
  const localLogs = await loadAuditLog(userId);
  const localDepartures = filterByType(
    filterByDays(localLogs, days),
    ['Auto-Depart', 'Manual Depart']
  ).filter(log => log.status === 'SUCCESS');

  // Get game history departures
  const gameDepartures = await vesselHistoryStore.getDeparturesByDays(userId, days);

  // If no local departures, use only game departures
  if (localDepartures.length === 0) {
    return gameDepartures;
  }

  // Find earliest local log timestamp
  const earliestLocal = Math.min(...localDepartures.map(d => d.timestamp));

  // Split game departures: before and after earliest local
  const gameBeforeLocal = gameDepartures.filter(d => d.timestamp < earliestLocal);
  const gameAfterLocal = gameDepartures.filter(d => d.timestamp >= earliestLocal);

  // Build set of local departure keys for deduplication (vessel_id + rounded timestamp)
  const DEDUP_WINDOW = 5 * 60 * 1000; // 5 minutes
  const localKeys = new Set();

  localDepartures.forEach(log => {
    const vessels = log.details?.departedVessels || log.details?.vessels || [];
    vessels.forEach(v => {
      const vesselId = v.vesselId || v.vessel_id;
      if (vesselId) {
        // Round timestamp to nearest 5 minutes for fuzzy matching
        const roundedTime = Math.floor(log.timestamp / DEDUP_WINDOW) * DEDUP_WINDOW;
        localKeys.add(`${vesselId}-${roundedTime}`);
      }
    });
  });

  // Filter game departures after local to remove duplicates
  const dedupedGameAfter = gameAfterLocal.filter(d => {
    const vessels = d.details?.departedVessels || [];
    if (vessels.length === 0) return false;

    const vesselId = vessels[0]?.vesselId;
    if (!vesselId) return false;

    const roundedTime = Math.floor(d.timestamp / DEDUP_WINDOW) * DEDUP_WINDOW;
    const key = `${vesselId}-${roundedTime}`;
    return !localKeys.has(key);
  });

  // Combine all sources
  const merged = [
    ...gameBeforeLocal,
    ...localDepartures,
    ...dedupedGameAfter
  ];

  // Sort by timestamp
  merged.sort((a, b) => a.timestamp - b.timestamp);

  return merged;
}

/**
 * Get vessel performance using merged departure data (local + game history)
 * @param {string} userId - User ID
 * @param {number} days - Number of days to analyze (default 30)
 * @returns {Promise<Array>} Vessel performance data
 */
async function getVesselPerformanceMerged(userId, days = 30) {
  const departures = await getMergedDepartures(userId, days);

  // Aggregate by vessel
  const vesselMap = new Map();

  departures.forEach(log => {
    const vessels = log.details?.departedVessels || log.details?.vessels || [];
    vessels.forEach(v => {
      const id = v.vesselId || v.vessel_id;
      if (!id) return;

      if (!vesselMap.has(id)) {
        vesselMap.set(id, {
          vesselId: id,
          name: v.name || v.vesselName || `Vessel ${id}`,
          trips: 0,
          totalRevenue: 0,
          totalFuelUsed: 0,
          totalCO2Used: 0,
          totalHarborFees: 0,
          totalContribution: 0,
          totalDistance: 0,
          utilizationSum: 0,
          routes: new Map(),
          sources: { local: 0, game: 0 }
        });
      }

      const vessel = vesselMap.get(id);
      vessel.trips++;
      vessel.totalRevenue += v.income || 0;
      vessel.totalFuelUsed += v.fuelUsed || 0;
      vessel.totalCO2Used += v.co2Used || 0;
      vessel.totalHarborFees += Math.abs(v.harborFee || 0);
      vessel.totalContribution += v.contributionGained || 0;
      vessel.totalDistance += v.distance || 0;
      vessel.utilizationSum += v.utilization || 0;

      // Track source
      if (log.source === 'game-api') {
        vessel.sources.game++;
      } else {
        vessel.sources.local++;
      }

      // Track routes
      const routeKey = `${v.origin}<>${v.destination}`;
      if (v.origin && v.destination) {
        const current = vessel.routes.get(routeKey);
        vessel.routes.set(routeKey, current ? current + 1 : 1);
      }
    });
  });

  // Calculate averages and convert to array
  const results = [];
  vesselMap.forEach((vessel, id) => {
    const avgUtilization = vessel.trips > 0 ? vessel.utilizationSum / vessel.trips : 0;
    const avgRevenuePerTrip = vessel.trips > 0 ? vessel.totalRevenue / vessel.trips : 0;
    const fuelEfficiency = vessel.totalFuelUsed > 0 ? vessel.totalDistance / vessel.totalFuelUsed : 0;

    // Find most used route
    let primaryRoute = null;
    let maxRouteTrips = 0;
    vessel.routes.forEach((count, route) => {
      if (count > maxRouteTrips) {
        maxRouteTrips = count;
        primaryRoute = route;
      }
    });

    results.push({
      vesselId: id,
      name: vessel.name,
      trips: vessel.trips,
      totalRevenue: vessel.totalRevenue,
      totalFuelUsed: vessel.totalFuelUsed,
      totalCO2Used: vessel.totalCO2Used,
      totalHarborFees: vessel.totalHarborFees,
      totalContribution: vessel.totalContribution,
      totalDistance: vessel.totalDistance,
      avgUtilization: avgUtilization * 100,
      avgRevenuePerTrip,
      fuelEfficiency,
      primaryRoute: formatRouteDisplay(primaryRoute),
      routeCount: vessel.routes.size,
      dataSources: vessel.sources
    });
  });

  // Sort by revenue descending
  results.sort((a, b) => b.totalRevenue - a.totalRevenue);

  return results;
}

/**
 * Get route profitability using merged departure data (local + game history)
 * @param {string} userId - User ID
 * @param {number} days - Number of days to analyze (default 30)
 * @returns {Promise<Array>} Route profitability data
 */
async function getRouteProfitabilityMerged(userId, days = 30) {
  const departures = await getMergedDepartures(userId, days);

  // Aggregate by route
  const routeMap = new Map();

  departures.forEach(log => {
    const vessels = log.details?.departedVessels || log.details?.vessels || [];
    vessels.forEach(v => {
      const origin = v.origin || '';
      const destination = v.destination || '';
      if (!origin || !destination) return;

      const routeKey = `${origin}<>${destination}`;

      if (!routeMap.has(routeKey)) {
        routeMap.set(routeKey, {
          route: routeKey,
          origin,
          destination,
          trips: 0,
          totalRevenue: 0,
          totalHarborFees: 0,
          totalFuelUsed: 0,
          totalDistance: 0,
          vessels: new Set(),
          sources: { local: 0, game: 0 }
        });
      }

      const route = routeMap.get(routeKey);
      route.trips++;
      route.totalRevenue += v.income || 0;
      route.totalHarborFees += Math.abs(v.harborFee || 0);
      route.totalFuelUsed += v.fuelUsed || 0;
      route.totalDistance += v.distance || 0;
      route.vessels.add(v.vesselId || v.vessel_id);

      // Track source
      if (log.source === 'game-api') {
        route.sources.game++;
      } else {
        route.sources.local++;
      }
    });
  });

  // Calculate metrics and convert to array
  const results = [];
  routeMap.forEach((route) => {
    const avgRevenuePerTrip = route.trips > 0 ? route.totalRevenue / route.trips : 0;
    const avgHarborFee = route.trips > 0 ? route.totalHarborFees / route.trips : 0;
    const harborFeePercent = route.totalRevenue > 0 ? (route.totalHarborFees / route.totalRevenue) * 100 : 0;
    const revenuePerKm = route.totalDistance > 0 ? route.totalRevenue / route.totalDistance : 0;

    results.push({
      route: route.route,
      origin: route.origin,
      destination: route.destination,
      displayRoute: formatRouteDisplay(route.route),
      trips: route.trips,
      totalRevenue: route.totalRevenue,
      totalHarborFees: route.totalHarborFees,
      totalFuelUsed: route.totalFuelUsed,
      totalDistance: route.totalDistance,
      avgRevenuePerTrip,
      avgHarborFee,
      harborFeePercent,
      revenuePerKm,
      vesselCount: route.vessels.size,
      dataSources: route.sources
    });
  });

  // Sort by total revenue descending
  results.sort((a, b) => b.totalRevenue - a.totalRevenue);

  return results;
}

/**
 * Get operations summary from merged departure data
 * @param {string} userId - User ID
 * @param {number} days - Number of days to analyze
 * @returns {Promise<Object>} Operations summary
 */
async function getMergedOperationsSummary(userId, days) {
  const departures = await getMergedDepartures(userId, days);

  let totalTrips = 0;
  let totalRevenue = 0;
  let totalFuelUsed = 0;
  let totalDistance = 0;
  let localCount = 0;
  let gameCount = 0;

  departures.forEach(log => {
    const vessels = log.details?.departedVessels || log.details?.vessels || [];
    totalTrips += vessels.length;

    if (log.source === 'game-api') {
      gameCount++;
    } else {
      localCount++;
    }

    vessels.forEach(v => {
      totalRevenue += v.income || 0;
      totalFuelUsed += v.fuelUsed || 0;
      totalDistance += v.distance || 0;
    });
  });

  return {
    totalTrips,
    totalRevenue,
    totalFuelUsed,
    totalDistance,
    departureCount: departures.length,
    dataSources: {
      local: localCount,
      game: gameCount
    }
  };
}

module.exports = {
  loadAuditLog,
  loadTripData,
  getWeeklySummary,
  getVesselPerformance,
  getRouteProfitability,
  getPurchaseAnalysis,
  getHarborFeeAnalysis,
  getContributionAnalysis,
  getDailyRevenueTrend,
  getRouteContribution,
  getDetailedExpenses,
  getActionTypes,
  getFilteredLogs,
  getMergedSummary,
  getVesselPerformanceWithContribution,
  getRouteProfitabilityWithContribution,
  getMergedDepartures,
  getVesselPerformanceMerged,
  getRouteProfitabilityMerged,
  getMergedOperationsSummary
};
