const { Pool } = require('pg');
const db = require('./database');

const pool = new Pool({
    user: 'postgres',
    host: 'localhost',
    database: 'orderbook',
    password: 'your_password',
    port: 5432,
});

// Utility functions
const calculateMarketPrice = async (type, quantity, currencyPair) => {
    const oppositeType = type === 'buy' ? 'sell' : 'buy';
    const orders = await db.getOpenOrders(oppositeType, currencyPair);
    let remainingQuantity = quantity;
    let totalCost = 0;

    for (const order of orders.rows) {
        const available = order.quantity - order.filled_quantity;
        const fillQuantity = Math.min(remainingQuantity, available);
        totalCost += fillQuantity * order.price;
        remainingQuantity -= fillQuantity;

        if (remainingQuantity <= 0) break;
    }

    if (remainingQuantity > 0) {
        throw new Error('Insufficient liquidity for market order');
    }

    return totalCost / quantity; // Average execution price
};

// Order validation functions
const validateOrder = async (userId, type, orderType, price, quantity, currencyPair, triggerPrice) => {
    if (quantity <= 0) {
        throw new Error('Quantity must be greater than 0');
    }

    if (orderType !== 'market' && price <= 0) {
        throw new Error('Price must be greater than 0');
    }

    if (['stop_loss', 'take_profit'].includes(orderType) && (!triggerPrice || triggerPrice <= 0)) {
        throw new Error('Trigger price must be specified for stop-loss and take-profit orders');
    }

    // Check user balance
    const [baseCurrency, quoteCurrency] = currencyPair.split('/');
    const userBalance = type === 'buy' 
        ? await db.getBalance(userId, quoteCurrency)
        : await db.getBalance(userId, baseCurrency);

    if (type === 'buy') {
        const estimatedCost = orderType === 'market' 
            ? await calculateMarketPrice(type, quantity, currencyPair) * quantity
            : price * quantity;
            
        if (userBalance < estimatedCost) {
            throw new Error(`Insufficient ${quoteCurrency} balance`);
        }
    } else {
        if (userBalance < quantity) {
            throw new Error(`Insufficient ${baseCurrency} balance`);
        }
    }
};

// Core order processing functions
const processMarketOrder = async (order, client) => {
    const oppositeType = order.type === 'buy' ? 'sell' : 'buy';
    const matchingOrders = await db.getOpenOrders(oppositeType, order.currency_pair);
    let remainingQuantity = order.quantity;

    for (const matchOrder of matchingOrders.rows) {
        if (remainingQuantity <= 0) break;

        const availableQuantity = matchOrder.quantity - matchOrder.filled_quantity;
        const tradeQuantity = Math.min(remainingQuantity, availableQuantity);

        await executeTrade(order, matchOrder, matchOrder.price, tradeQuantity, client);
        remainingQuantity -= tradeQuantity;
    }

    if (remainingQuantity > 0) {
        throw new Error('Insufficient liquidity to complete market order');
    }
};

const processLimitOrder = async (order, client) => {
    const oppositeType = order.type === 'buy' ? 'sell' : 'buy';
    const matchingOrders = await db.getOpenOrders(oppositeType, order.currency_pair);
    let remainingQuantity = order.quantity;

    for (const matchOrder of matchingOrders.rows) {
        if (remainingQuantity <= 0) break;

        const priceMatches = order.type === 'buy' 
            ? order.price >= matchOrder.price
            : order.price <= matchOrder.price;

        if (!priceMatches) break;

        const availableQuantity = matchOrder.quantity - matchOrder.filled_quantity;
        const tradeQuantity = Math.min(remainingQuantity, availableQuantity);

        await executeTrade(order, matchOrder, matchOrder.price, tradeQuantity, client);
        remainingQuantity -= tradeQuantity;
    }

    return remainingQuantity;
};

const executeTrade = async (order1, order2, price, quantity, client) => {
    // Determine buy and sell orders
    const buyOrder = order1.type === 'buy' ? order1 : order2;
    const sellOrder = order1.type === 'sell' ? order1 : order2;

    // Record the trade
    await db.insertTrade(
        buyOrder.id,
        sellOrder.id,
        price,
        quantity,
        buyOrder.currency_pair,
        client
    );

    // Update order statuses
    const [buyFilledQty, sellFilledQty] = await Promise.all([
        updateOrderFill(buyOrder, quantity, client),
        updateOrderFill(sellOrder, quantity, client)
    ]);

    // Update user balances
    const [baseCurrency, quoteCurrency] = buyOrder.currency_pair.split('/');
    await Promise.all([
        // Credit seller with quote currency (e.g., USD)
        db.updateBalance(sellOrder.user_id, quoteCurrency, price * quantity, client),
        // Credit buyer with base currency (e.g., BTC)
        db.updateBalance(buyOrder.user_id, baseCurrency, quantity, client)
    ]);

    return {
        buyOrderStatus: buyFilledQty === buyOrder.quantity ? 'filled' : 'partial',
        sellOrderStatus: sellFilledQty === sellOrder.quantity ? 'filled' : 'partial'
    };
};

const updateOrderFill = async (order, fillQuantity, client) => {
    const newFilledQuantity = order.filled_quantity + fillQuantity;
    const status = newFilledQuantity === order.quantity ? 'filled' : 'partial';
    const result = await db.updateOrderStatus(order.id, status, newFilledQuantity, client);
    return newFilledQuantity;
};

// Public API
const addOrder = async (userId, type, orderType, price, quantity, currencyPair, triggerPrice = null) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Validate order parameters
        await validateOrder(userId, type, orderType, price, quantity, currencyPair, triggerPrice);

        // For market orders, calculate estimated price
        if (orderType === 'market') {
            price = await calculateMarketPrice(type, quantity, currencyPair);
        }

        // Create the order
        const orderResult = await db.insertOrder(
            userId, type, orderType, price, quantity, 
            currencyPair, triggerPrice, client
        );
        const order = orderResult.rows[0];

        // Process the order based on type
        if (orderType === 'market') {
            await processMarketOrder(order, client);
        } else if (orderType === 'limit') {
            const remainingQuantity = await processLimitOrder(order, client);
            if (remainingQuantity === 0) {
                await db.updateOrderStatus(order.id, 'filled', quantity, client);
            } else if (remainingQuantity < quantity) {
                await db.updateOrderStatus(order.id, 'partial', quantity - remainingQuantity, client);
            }
        }
        // Stop-loss and take-profit orders remain in 'triggered' status until price conditions are met

        await client.query('COMMIT');
        return order;
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
};

const cancelOrder = async (orderId, userId) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const orderResult = await client.query(
            'SELECT * FROM orders WHERE id = $1 AND user_id = $2',
            [orderId, userId]
        );

        if (orderResult.rows.length === 0) {
            throw new Error('Order not found');
        }

        const order = orderResult.rows[0];
        if (order.status === 'filled') {
            throw new Error('Cannot cancel filled order');
        }

        // Return funds to user
        const [baseCurrency, quoteCurrency] = order.currency_pair.split('/');
        const remainingQuantity = order.quantity - order.filled_quantity;

        if (order.type === 'buy') {
            await db.updateBalance(
                userId,
                quoteCurrency,
                order.price * remainingQuantity,
                client
            );
        } else {
            await db.updateBalance(
                userId,
                baseCurrency,
                remainingQuantity,
                client
            );
        }

        await db.updateOrderStatus(orderId, 'cancelled', order.filled_quantity, client);
        await client.query('COMMIT');
        return order;
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
};

const checkTriggerOrders = async (currentPrice, currencyPair) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const triggeredOrders = await db.getTriggeredOrders(currentPrice, currencyPair);
        
        for (const order of triggeredOrders.rows) {
            const shouldTrigger = (
                (order.type === 'sell' && order.order_type === 'stop_loss' && currentPrice <= order.trigger_price) ||
                (order.type === 'sell' && order.order_type === 'take_profit' && currentPrice >= order.trigger_price) ||
                (order.type === 'buy' && order.order_type === 'stop_loss' && currentPrice >= order.trigger_price) ||
                (order.type === 'buy' && order.order_type === 'take_profit' && currentPrice <= order.trigger_price)
            );

            if (shouldTrigger) {
                await addOrder(
                    order.user_id,
                    order.type,
                    'market',
                    currentPrice,
                    order.quantity,
                    order.currency_pair
                );
                await db.updateOrderStatus(order.id, 'filled', order.quantity, client);
            }
        }

        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error processing trigger orders:', error);
    } finally {
        client.release();
    }
};

const getUserActiveOrders = async (userId) => {
    return db.getUserOrders(userId, ['open', 'partial', 'triggered']);
};

const getUserOrderHistory = async (userId) => {
    return db.getUserOrders(userId);
};

module.exports = {
    addOrder,
    cancelOrder,
    checkTriggerOrders,
    getUserActiveOrders,
    getUserOrderHistory
};