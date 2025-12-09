/**
 * @fileoverview Route Planner API Routes
 *
 * Provides endpoints for route planning functionality:
 * - Get available ports for a vessel
 * - Get suggested route for a vessel
 * - Get route data between two ports
 * - Create/assign route to vessel
 *
 * @module server/routes/route-planner
 */

const express = require('express');
const { apiCall, getUserId } = require('../utils/api');
const logger = require('../utils/logger');
const logbook = require('../logbook');

const router = express.Router();

/**
 * POST /api/route/get-vessel-ports
 * Gets available ports for a vessel (local, metropol, all reachable)
 *
 * @route POST /api/route/get-vessel-ports
 * @param {number} user_vessel_id - Vessel ID
 * @returns {object} Port data with local, metropolis, and all ports
 */
router.post('/get-vessel-ports', async (req, res) => {
  try {
    const { user_vessel_id } = req.body;

    if (!user_vessel_id) {
      return res.status(400).json({ error: 'Missing user_vessel_id' });
    }

    logger.info(`[Route Planner] Getting ports for vessel ${user_vessel_id}`);

    const data = await apiCall('/route/get-vessel-ports', 'POST', {
      user_vessel_id: user_vessel_id
    });

    // Extract origin port from vessel data
    let origin = null;
    if (data.data?.vessel?.current_port) {
      origin = data.data.vessel.current_port;
    }

    res.json({
      success: true,
      data: {
        origin: origin,
        local: data.data?.local || { ports: [] },
        metropolis: data.data?.metropolis || { ports: [] },
        all: data.data?.all || { ports: [] }
      }
    });

  } catch (error) {
    logger.error(`[Route Planner] Failed to get vessel ports: ${error.message}`);
    res.status(500).json({ error: 'Failed to get vessel ports' });
  }
});

/**
 * POST /api/route/get-suggested-route
 * Gets a random suggested route for a vessel
 *
 * @route POST /api/route/get-suggested-route
 * @param {number} user_vessel_id - Vessel ID
 * @returns {object} Suggested route data
 */
router.post('/get-suggested-route', async (req, res) => {
  try {
    const { user_vessel_id } = req.body;

    if (!user_vessel_id) {
      return res.status(400).json({ error: 'Missing user_vessel_id' });
    }

    logger.info(`[Route Planner] Getting suggested route for vessel ${user_vessel_id}`);

    const data = await apiCall('/route/get-suggested-route', 'POST', {
      user_vessel_id: user_vessel_id
    });

    res.json({
      success: true,
      data: data.data || {}
    });

  } catch (error) {
    logger.error(`[Route Planner] Failed to get suggested route: ${error.message}`);
    res.status(500).json({ error: 'Failed to get suggested route' });
  }
});

/**
 * POST /api/route/get-routes-by-ports
 * Gets route data between two ports
 *
 * @route POST /api/route/get-routes-by-ports
 * @param {string} port1 - Origin port code
 * @param {string} port2 - Destination port code
 * @returns {object} Route data with distance, hijacking risk, fees
 */
router.post('/get-routes-by-ports', async (req, res) => {
  try {
    const { port1, port2 } = req.body;

    if (!port1 || !port2) {
      return res.status(400).json({ error: 'Missing port1 or port2' });
    }

    logger.info(`[Route Planner] Getting route: ${port1} -> ${port2}`);

    const data = await apiCall('/route/get-routes-by-ports', 'POST', {
      port1: port1,
      port2: port2
    });

    res.json({
      success: true,
      routes: data.data?.routes || [],
      reversed: data.data?.reversed || false
    });

  } catch (error) {
    logger.error(`[Route Planner] Failed to get routes: ${error.message}`);
    res.status(500).json({ error: 'Failed to get routes' });
  }
});

/**
 * POST /api/route/create-user-route
 * Creates/assigns a route to a vessel
 *
 * @route POST /api/route/create-user-route
 * @param {number} route_id - Route ID
 * @param {number} user_vessel_id - Vessel ID
 * @param {number} speed - Travel speed (1-20)
 * @param {number} guards - Number of guards (0-10)
 * @param {number} dry_operation - Dry cargo operation mode
 * @param {number} price_dry - Dry cargo price
 * @param {number} price_refrigerated - Refrigerated cargo price
 * @returns {object} Route creation result
 */
router.post('/create-user-route', async (req, res) => {
  try {
    const {
      route_id,
      user_vessel_id,
      speed,
      guards,
      dry_operation,
      price_dry,
      price_refrigerated,
      price_fuel,
      price_crude_oil,
      // Calculated fees from client for logging
      calculated_route_fee,
      calculated_channel_cost,
      calculated_total_fee
    } = req.body;

    if (!route_id || !user_vessel_id) {
      return res.status(400).json({ error: 'Missing route_id or user_vessel_id' });
    }

    logger.info(`[Route Planner] Creating route ${route_id} for vessel ${user_vessel_id}`);
    logger.info(`[Route Planner] SENDING prices to game: dry=${price_dry}, ref=${price_refrigerated}, fuel=${price_fuel}, crude=${price_crude_oil}`);

    const data = await apiCall('/route/create-user-route', 'POST', {
      route_id,
      user_vessel_id,
      speed,
      guards,
      dry_operation,
      price_dry,
      price_refrigerated,
      price_fuel,
      price_crude_oil
    });

    logger.info(`[Route Planner] GAME RETURNED prices: dry=${data.data?.user_vessel?.prices?.dry}, ref=${data.data?.user_vessel?.prices?.refrigerated}, fuel=${data.data?.user_vessel?.prices?.fuel}, crude=${data.data?.user_vessel?.prices?.crude_oil}`);

    // Log the route creation to the logbook
    try {
      const userId = getUserId();
      if (userId && data.data?.user_vessel) {
        const vessel = data.data.user_vessel;
        const feeDisplay = calculated_total_fee ? ` | Fee: $${calculated_total_fee.toLocaleString()}` : '';
        const summary = `${vessel.name} | ${vessel.route_origin} -> ${vessel.route_destination} | ${vessel.route_distance} nm @ ${vessel.route_speed} kn${feeDisplay}`;
        await logbook.logAutopilotAction(userId, 'Manual Route Planner', 'SUCCESS', summary, {
          vessel_id: vessel.id,
          vessel_name: vessel.name,
          route_origin: vessel.route_origin,
          route_destination: vessel.route_destination,
          route_distance: vessel.route_distance,
          route_speed: vessel.route_speed,
          route_guards: vessel.route_guards,
          route_name: vessel.route_name,
          route_fee: calculated_route_fee,
          channel_cost: calculated_channel_cost,
          total_fee: calculated_total_fee,
          api_response: data.data
        });
        logger.debug(`[Route Planner] Logged route creation to logbook for vessel ${vessel.name}`);
      }
    } catch (logError) {
      logger.error(`[Route Planner] Failed to log route creation: ${logError.message}`);
      // Don't fail the request if logging fails
    }

    // Broadcast vessel count update after successful route creation
    // This updates the anchor badge on the frontend
    try {
      const { broadcastToUser } = require('../websocket/broadcaster');
      const userId = getUserId();

      if (userId && broadcastToUser) {
        // Fetch lightweight vessel data (not the 3.5MB /game/index)
        const vesselsData = await apiCall('/vessel/get-all-user-vessels', 'POST', {
          include_routes: false
        });

        if (vesselsData?.data?.user_vessels) {
          const vessels = vesselsData.data.user_vessels;
          const readyToDepart = vessels.filter(v => v.status === 'port' && v.route_destination).length;
          const atAnchor = vessels.filter(v => v.status === 'anchor').length;
          const pending = vessels.filter(v => v.status === 'pending').length;

          broadcastToUser(userId, 'vessel_count_update', {
            readyToDepart,
            atAnchor,
            pending,
            total: vessels.length
          });

          logger.debug(`[Route Planner] Broadcast vessel count: ready=${readyToDepart}, anchor=${atAnchor}, pending=${pending}`);
        }
      }
    } catch (broadcastError) {
      logger.error(`[Route Planner] Failed to broadcast vessel count: ${broadcastError.message}`);
      // Don't fail the request if broadcast fails
    }

    res.json({
      success: true,
      data: data.data || {}
    });

  } catch (error) {
    logger.error(`[Route Planner] Failed to create route: ${error.message}`);
    res.status(500).json({ error: 'Failed to create route' });
  }
});

/**
 * POST /api/route/get-port-demand
 * Gets demand data for a specific port (works for non-assigned ports too)
 *
 * @route POST /api/route/get-port-demand
 * @param {string} port_code - Port code
 * @returns {object} Port data with demand
 */
router.post('/get-port-demand', async (req, res) => {
  try {
    const { port_code } = req.body;

    if (!port_code) {
      return res.status(400).json({ error: 'Missing port_code' });
    }

    logger.info(`[Route Planner] Getting demand for port ${port_code}`);

    const data = await apiCall('/port/get-ports', 'POST', {
      port_code: [port_code]
    });

    const port = data.data?.port?.[0];

    if (!port) {
      return res.status(404).json({ error: 'Port not found' });
    }

    res.json({
      success: true,
      port: port
    });

  } catch (error) {
    logger.error(`[Route Planner] Failed to get port demand: ${error.message}`);
    res.status(500).json({ error: 'Failed to get port demand' });
  }
});

/**
 * POST /api/route/update-route-data
 * Updates speed, guards, and prices for an existing route
 *
 * @route POST /api/route/update-route-data
 * @param {number} user_vessel_id - Vessel ID
 * @param {number} speed - Travel speed (1 to max_speed)
 * @param {number} guards - Number of guards (0-5)
 * @param {object} prices - { dry: number, refrigerated: number }
 * @returns {object} Updated vessel data
 */
router.post('/update-route-data', async (req, res) => {
  try {
    const { user_vessel_id, speed, guards, prices } = req.body;

    if (!user_vessel_id) {
      return res.status(400).json({ error: 'Missing user_vessel_id' });
    }

    logger.info(`[Route Planner] Updating route for vessel ${user_vessel_id}: speed=${speed}, guards=${guards}`);

    const data = await apiCall('/route/update-route-data', 'POST', {
      user_vessel_id: user_vessel_id,
      speed: speed,
      guards: guards,
      prices: prices
    });

    // Log the route update to the logbook
    try {
      const userId = getUserId();
      if (userId && data.data?.user_vessel) {
        const vessel = data.data.user_vessel;
        const summary = `${vessel.name} | Speed: ${speed} kn, Guards: ${guards}`;
        await logbook.logAutopilotAction(userId, 'Manual Route Update', 'SUCCESS', summary, {
          vessel_id: vessel.id,
          vessel_name: vessel.name,
          route_speed: speed,
          route_guards: guards,
          prices: prices
        });
        logger.debug(`[Route Planner] Logged route update to logbook for vessel ${vessel.name}`);
      }
    } catch (logError) {
      logger.error(`[Route Planner] Failed to log route update: ${logError.message}`);
    }

    res.json({
      success: true,
      data: data.data || {}
    });

  } catch (error) {
    logger.error(`[Route Planner] Failed to update route: ${error.message}`);
    res.status(500).json({ error: 'Failed to update route' });
  }
});

/**
 * POST /api/route/auto-price
 * Gets AI-calculated optimal pricing for a route
 *
 * @route POST /api/route/auto-price
 * @param {number} route_id - Route ID
 * @param {number} user_vessel_id - Vessel ID
 * @returns {object} Auto-price data
 */
router.post('/auto-price', async (req, res) => {
  try {
    const { route_id, user_vessel_id } = req.body;

    if (!route_id) {
      return res.status(400).json({ error: 'Missing route_id' });
    }

    if (!user_vessel_id) {
      return res.status(400).json({ error: 'Missing user_vessel_id' });
    }

    logger.info(`[Route Planner] Getting auto-price for route ${route_id}, vessel ${user_vessel_id}`);

    const data = await apiCall('/demand/auto-price', 'POST', {
      user_vessel_id: user_vessel_id,
      route_id: route_id
    });

    res.json({
      success: true,
      data: data.data || {}
    });

  } catch (error) {
    logger.error(`[Route Planner] Failed to get auto-price: ${error.message}`);
    res.status(500).json({ error: 'Failed to get auto-price' });
  }
});

module.exports = router;
