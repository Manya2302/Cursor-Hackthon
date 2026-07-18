const express = require('express');
const cors = require('cors');
const morgan = require('morgan');

require('./config/supabase');
const healthRouter = require('./routes/health');

const app = express();

app.use(cors());
app.use(morgan('dev'));
app.use(express.json());

app.use('/', healthRouter);

module.exports = app;
