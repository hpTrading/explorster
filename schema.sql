-- Create users table
CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(50) UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create user_balances table
CREATE TABLE user_balances (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id),
    currency VARCHAR(10) NOT NULL,
    amount DECIMAL DEFAULT 0.0,
    UNIQUE(user_id, currency)
);

-- Modified orders table with new fields
CREATE TABLE orders (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id),
    type TEXT CHECK (type IN ('buy', 'sell')),
    order_type TEXT CHECK (order_type IN ('market', 'limit', 'stop_loss', 'take_profit')),
    price DECIMAL CHECK (price > 0),
    trigger_price DECIMAL NULL CHECK (trigger_price > 0),
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    filled_quantity INTEGER DEFAULT 0 CHECK (filled_quantity <= quantity),
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    status TEXT CHECK (status IN ('open', 'partial', 'filled', 'cancelled', 'triggered')),
    currency_pair VARCHAR(10) NOT NULL -- e.g., 'ES/USD'
);

-- Modified trades table
CREATE TABLE trades (
    id SERIAL PRIMARY KEY,
    buy_order_id INTEGER REFERENCES orders(id),
    sell_order_id INTEGER REFERENCES orders(id),
    price DECIMAL NOT NULL CHECK (price > 0),
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    currency_pair VARCHAR(10) NOT NULL
);

-- Create indexes
CREATE INDEX idx_orders_user_id ON orders(user_id);
CREATE INDEX idx_orders_type_status ON orders(type, status);
CREATE INDEX idx_orders_timestamp ON orders(timestamp);
CREATE INDEX idx_trades_timestamp ON trades(timestamp);
CREATE INDEX idx_user_balances_user_id ON user_balances(user_id);
CREATE INDEX idx_orders_trigger_price ON orders(trigger_price) WHERE trigger_price IS NOT NULL;