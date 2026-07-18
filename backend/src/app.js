const path = require('path');
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');

require('./config/supabase');
const healthRouter = require('./routes/health');
const webhookRouter = require('./routes/webhook');
const authRouter = require(path.join(__dirname, '../../auth'));
const accountsRouter = require('./routes/accounts');
const inventoryRouter = require('./routes/inventory');
const statementsRouter = require('./routes/statements');
const vendorsRouter = require('./routes/vendors');
const productsRouter = require('./routes/products');

const app = express();

app.use(cors());
app.use(morgan('dev'));
app.use(express.json({ limit: '5mb' }));

app.use('/', healthRouter);
app.use('/', webhookRouter);
app.use('/api/auth', authRouter);
app.use('/', accountsRouter);
app.use('/', inventoryRouter);
app.use('/', statementsRouter);
app.use('/', vendorsRouter);
app.use('/', productsRouter);

module.exports = app;
