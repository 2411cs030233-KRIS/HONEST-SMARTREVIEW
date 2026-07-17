// src/config/index.js — re-exports all config modules
// Controllers import directly from '../config/db' etc.
// This file is kept for backwards compatibility.
module.exports = {
  ...require('./db'),
  ...require('./redis'),
};
