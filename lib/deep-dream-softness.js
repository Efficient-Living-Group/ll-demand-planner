// Explicit Deep Dream catalogue metadata for the active Demand Planner range.
// This is intentionally an exact SKU map: do not infer softness from SKU text.
const DEEP_DREAM_SOFTNESS_BY_SKU = Object.freeze({
  'DD-137D-PLUSH': 'plush',
  'DD-153Q-PLUSH': 'plush',
  'DD-183K-PLUSH': 'plush',
  'DD-107KSMF': 'medium',
  'DD-137DMF': 'medium',
  'DD-153QMF': 'medium',
  'DD-183KMF': 'medium',
  'DD-21153CF': 'medium',
  'DD-21183CF': 'medium',
  'DD-36137SG': 'medium',
  'DD-36153SG': 'medium',
  'DD-36183SG': 'medium',
  'DD-34137D-SFM': 'firm',
  'DD-34153Q-SFM': 'firm',
  'DD-34183K-SFM': 'firm'
});

module.exports = { DEEP_DREAM_SOFTNESS_BY_SKU };
