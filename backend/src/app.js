const path = require('path');
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');

require('./config/supabase');
const healthRouter = require('./routes/health');
const webhookRouter = require('./routes/webhook');
const authRouter = require(path.join(__dirname, '../../auth'));

const app = express();

app.use(cors());
app.use(morgan('dev'));
app.use(express.json());

app.use('/', healthRouter);
app.use('/', webhookRouter);
app.use('/api/auth', authRouter);

module.exports = app;
