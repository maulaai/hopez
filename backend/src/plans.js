'use strict';

// Plans drive both pricing UI and billing endpoint.
// Edit freely — `id` must be stable.
const PLANS = [
  {
    id: 'free',
    name: 'Free',
    tagline: 'For evaluation and hobby projects.',
    price_cents: 0,
    credits: 100,
    features: [
      '100 credits per month',
      '1 API key',
      'Community support'
    ]
  },
  {
    id: 'starter',
    name: 'Starter',
    tagline: 'For solo developers shipping side projects.',
    price_cents: 900,
    credits: 10_000,
    features: [
      '10,000 credits / month',
      'Unlimited API keys',
      'Email support'
    ]
  },
  {
    id: 'pro',
    name: 'Pro',
    tagline: 'For teams running real workloads.',
    price_cents: 4900,
    credits: 100_000,
    features: [
      '100,000 credits / month',
      'Unlimited API keys',
      'Priority support',
      'Higher rate limits'
    ],
    recommended: true
  },
  {
    id: 'scale',
    name: 'Scale',
    tagline: 'For high-traffic production systems.',
    price_cents: 19900,
    credits: 500_000,
    features: [
      '500,000 credits / month',
      'Dedicated support',
      'SLA available'
    ]
  }
];

function getPlan(id) {
  return PLANS.find(p => p.id === id);
}

module.exports = { PLANS, getPlan };
