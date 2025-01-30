const { Pool } = require('pg');
const bcrypt = require('bcrypt');

const pool = new Pool({
    user: process.env.DB_USER || 'postgres',
    host: process.env.DB_HOST || 'localhost',
    database: process.env.DB_NAME || 'orderbook',
    password: process.env.DB_PASSWORD || 'your_password',
    port: process.env.DB_PORT ? parseInt(process.env.DB_PORT) : 5432,
});

// Test database connection
pool.connect((err, client, release) => {
    if (err) {
        console.error('Error connecting to the database:', err.message);
        return;
    }
    console.log('Successfully connected to database');
    release();
});

// Query helper function
const query = async (text, params) => {
    const result = await pool.query(text, params);
    return result;
};

// User management functions
const createUser = async (username, password, email) => {
    const passwordHash = await bcrypt.hash(password, 10);
    const text = `
        INSERT INTO users (username, password_hash, email)
        VALUES ($1, $2, $3)
        RETURNING id, username, email, created_at
    `;
    const values = [username, passwordHash, email];
    return query(text, values);
};

const validateUser = async (username, password) => {
    const text = 'SELECT * FROM users WHERE username = $1';
    const result = await query(text, [username]);
    if (result.rows.length === 0) return null;
    
    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    return valid ? { id: user.id, username: user.username, email: user.email } : null;
};

// Balance management functions
const updateBalance = async (userId, currency, amount, client = pool) => {
    const text = `
        INSERT INTO user_balances (user_id, currency, amount)
        VALUES ($1, $2, $3)
        ON CONFLICT (user_id, currency)
        DO UPDATE SET amount = user_balances.amount + $3
        RETURNING *
    `;
    return client.query(text, [userId, currency, amount]);
};

const getBalance = async (userId, currency) => {
    const text = 'SELECT amount FROM user_balances WHERE user_id = $1 AND currency = $2';
    const result = await query(text, [userId, currency]);
    return result.rows[0]?.amount || 0;
};

// Enhanced order management functions
const insertOrder = async (userId, type, orderType, price, quantity, currencyPair, triggerPrice = null) => {
    const text = `
        INSERT INTO orders (
            user_id, type, order_type, price, quantity, 
            currency_pair, trigger_price, status
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING *
    `;
    const status = orderType === 'market' ? 'open' : 
                  (orderType === 'stop_loss' || orderType === 'take_profit') ? 'triggered' : 'open';
    const values = [userId, type, orderType, price, quantity, currencyPair, triggerPrice, status];
    return query(text, values);
};

const updateOrderStatus = async (orderId, status, filledQuantity, client = pool) => {
    const text = `
        UPDATE orders 
        SET status = $1, 
            filled_quantity = COALESCE($2, filled_quantity)
        WHERE id = $3
        RETURNING *
    `;
    return client.query(text, [status, filledQuantity, orderId]);
};

const getOpenOrders = async (type, currencyPair) => {
    const text = `
        SELECT * FROM orders
        WHERE type = $1 
        AND currency_pair = $2
        AND status IN ('open', 'partial')
        AND (order_type = 'market' OR order_type = 'limit')
        ORDER BY 
            CASE 
                WHEN type = 'buy' THEN price END DESC,
            CASE 
                WHEN type = 'sell' THEN price END ASC,
            timestamp ASC
    `;
    return query(text, [type, currencyPair]);
};

const getTriggeredOrders = async (currentPrice, currencyPair) => {
    const text = `
        SELECT * FROM orders
        WHERE currency_pair = $1
        AND status = 'triggered'
        AND (
            (order_type = 'stop_loss' AND type = 'sell' AND $2 <= trigger_price)
            OR 
            (order_type = 'take_profit' AND type = 'sell' AND $2 >= trigger_price)
            OR
            (order_type = 'stop_loss' AND type = 'buy' AND $2 >= trigger_price)
            OR
            (order_type = 'take_profit' AND type = 'buy' AND $2 <= trigger_price)
        )
    `;
    return query(text, [currencyPair, currentPrice]);
};

const getUserOrders = async (userId, status = null) => {
    const text = `
        SELECT * FROM orders
        WHERE user_id = $1
        ${status ? 'AND status = $2' : ''}
        ORDER BY timestamp DESC
    `;
    const values = status ? [userId, status] : [userId];
    return query(text, values);
};

const getOrderBook = async (currencyPair) => {
    const buyOrders = await getOpenOrders('buy', currencyPair);
    const sellOrders = await getOpenOrders('sell', currencyPair);
    
    // Group orders by price level
    const groupOrders = (orders) => {
        const grouped = {};
        orders.rows.forEach(order => {
            if (!grouped[order.price]) {
                grouped[order.price] = 0;
            }
            grouped[order.price] += (order.quantity - order.filled_quantity);
        });
        return Object.entries(grouped)
            .map(([price, quantity]) => ({
                price: parseFloat(price),
                quantity
            }));
    };

    return {
        buyOrders: groupOrders(buyOrders),
        sellOrders: groupOrders(sellOrders)
    };
};

module.exports = {
    query,
    createUser,
    validateUser,
    updateBalance,
    getBalance,
    insertOrder,
    updateOrderStatus,
    getOpenOrders,
    getTriggeredOrders,
    getUserOrders,
    getOrderBook
};
