require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const jwt = require('jsonwebtoken');
const orderbook = require('./orderbook');
const db = require('./database');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());
app.use(express.static('public'));

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
    console.error('JWT_SECRET environment variable is required');
    process.exit(1);
}

// Authentication middleware
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    
    if (!token) {
        return res.status(401).json({ error: 'Authentication required' });
    }
    
    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) {
            return res.status(403).json({ error: 'Invalid token' });
        }
        req.user = user;
        next();
    });
};

// WebSocket authentication and connection handling
wss.on('connection', async (ws, req) => {
    try {
        // Extract token from URL parameters
        const url = new URL(req.url, 'ws://localhost');
        const token = url.searchParams.get('token');
        
        if (!token) {
            ws.close(1008, 'Authentication required');
            return;
        }
        
        const user = jwt.verify(token, JWT_SECRET);
        ws.userId = user.id;
        
        // Send initial order book data
        const orderBookData = await db.getOrderBook('BTC/USD'); // Example currency pair
        ws.send(JSON.stringify({
            type: 'orderbook_update',
            data: orderBookData
        }));
        
        ws.on('error', console.error);
    } catch (error) {
        ws.close(1008, 'Authentication failed');
    }
});

// Broadcast order book updates to all connected clients
const broadcastOrderBook = async (currencyPair) => {
    const orderBookData = await db.getOrderBook(currencyPair);
    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
                type: 'orderbook_update',
                data: orderBookData
            }));
        }
    });
};

// User Routes
app.post('/api/register', async (req, res) => {
    try {
        const { username, password, email } = req.body;
        const user = await db.createUser(username, password, email);
        res.json({ message: 'User created successfully' });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

app.post('/api/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const user = await db.validateUser(username, password);
        
        if (!user) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        
        const token = jwt.sign(user, JWT_SECRET);
        res.json({ token, user });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Order Routes
app.post('/api/orders', authenticateToken, async (req, res) => {
    try {
        const { type, orderType, price, quantity, currencyPair, triggerPrice } = req.body;
        const order = await orderbook.addOrder(
            req.user.id,
            type,
            orderType,
            price,
            quantity,
            currencyPair,
            triggerPrice
        );
        
        await broadcastOrderBook(currencyPair);
        res.json(order);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

app.delete('/api/orders/:id', authenticateToken, async (req, res) => {
    try {
        const order = await orderbook.cancelOrder(req.params.id, req.user.id);
        await broadcastOrderBook(order.currency_pair);
        res.json(order);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

app.get('/api/orders/active', authenticateToken, async (req, res) => {
    try {
        const orders = await orderbook.getUserActiveOrders(req.user.id);
        res.json(orders);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/orders/history', authenticateToken, async (req, res) => {
    try {
        const orders = await orderbook.getUserOrderHistory(req.user.id);
        res.json(orders);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/balances/add', authenticateToken, async (req, res) => {
    try {
        const { currency, amount } = req.body;
        if (!currency || !amount || amount <= 0) {
            return res.status(400).json({ error: 'Invalid currency or amount' });
        }
        if (!['ES', 'USD'].includes(currency)) {
            return res.status(400).json({ error: 'Invalid currency. Must be ES or USD' });
        }
        const result = await db.updateBalance(req.user.id, currency, amount);
        if (result.rows.length === 0) {
            return res.status(500).json({ error: 'Failed to update balance' });
        }
        res.json({ message: 'Balance updated successfully' });
    } catch (error) {
        console.error('Balance update error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/balances', authenticateToken, async (req, res) => {
    try {
        const balances = {
            ES: await db.getBalance(req.user.id, 'ES'),
            USD: await db.getBalance(req.user.id, 'USD')
        };
        res.json(balances);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

// Price feed simulation for trigger orders (in production, you'd use real market data)
setInterval(async () => {
    const currentPrice = Math.random() * (4800 - 4700) + 4700; // Random price between 4700-4800 for ES
    await orderbook.checkTriggerOrders(currentPrice, 'ES/USD');
}, 5000);