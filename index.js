import 'dotenv/config';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const API_BASE = 'https://manapool.com/api/v1';
const API_KEY = process.env.MANAPOOL_API_KEY;
const API_EMAIL = process.env.MANAPOOL_EMAIL;

if (!API_KEY) {
  console.error('ERROR: MANAPOOL_API_KEY environment variable is not set');
  process.exit(1);
}

// Correct auth: X-ManaPool-Email + X-ManaPool-Access-Token
async function mpFetch(path, options = {}) {
  const url = `${API_BASE}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'X-ManaPool-Access-Token': API_KEY,
      ...(API_EMAIL ? { 'X-ManaPool-Email': API_EMAIL } : {}),
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, ok: res.ok, data };
}

// The optimizer streams newline-delimited JSON — parse the final line
function parseOptimizerResponse(text) {
  const lines = text.trim().split('\n').filter(Boolean);
  return JSON.parse(lines[lines.length - 1]);
}

// Run the optimizer, automatically retrying after removing unavailable cards.
// Returns { data, unavailable[] } on success, throws on unrecoverable error.
async function runOptimizer(cards, conditionIds, finishIds) {
  const unavailable = new Set();
  let remaining = [...cards];

  while (remaining.length > 0) {
    const cart = remaining.map(name => ({
      type: 'mtg_single',
      name,
      quantity_requested: 1,
      condition_ids: conditionIds,
      finish_ids: finishIds,
      language_ids: ['EN'],
    }));

    const res = await fetch(`${API_BASE}/buyer/optimizer`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-ManaPool-Access-Token': API_KEY,
        ...(API_EMAIL ? { 'X-ManaPool-Email': API_EMAIL } : {}),
      },
      body: JSON.stringify({ cart }),
    });

    const text = await res.text();

    if (res.status === 200) {
      const data = parseOptimizerResponse(text);
      return { data, unavailable: [...unavailable] };
    }

    if (res.status === 409) {
      let parsed;
      try { parsed = JSON.parse(text); } catch { throw new Error(`Optimizer error 409: ${text.slice(0, 200)}`); }
      const newlyUnavailable = (parsed.details || []).map(d => d.item?.name).filter(Boolean);
      if (newlyUnavailable.length === 0) throw new Error(`Optimizer 409 with no removable cards: ${text.slice(0, 200)}`);
      newlyUnavailable.forEach(n => unavailable.add(n));
      remaining = cards.filter(c => !unavailable.has(c));
      continue;
    }

    throw new Error(`Optimizer error ${res.status}: ${text.slice(0, 200)}`);
  }

  throw new Error('No cards remaining after removing unavailable items.');
}

const TOOLS = [
  {
    name: 'get_card_price',
    description: 'Get the best available price for a single MTG card on Manapool using the purchase optimizer.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Card name' },
        conditions: {
          type: 'array',
          items: { type: 'string', enum: ['NM', 'LP', 'MP', 'HP', 'DMG'] },
          description: 'Acceptable conditions (default: NM and LP)',
        },
        foil: { type: 'boolean', description: 'Foil version (default: false)' },
      },
      required: ['name'],
    },
  },
  {
    name: 'price_deck',
    description: 'Price a full list of MTG cards on Manapool using the purchase optimizer. Returns subtotal, shipping, fees, estimated total, and any cards not currently in stock.',
    inputSchema: {
      type: 'object',
      properties: {
        cards: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of card names (exclude basic lands)',
        },
        conditions: {
          type: 'array',
          items: { type: 'string', enum: ['NM', 'LP', 'MP', 'HP', 'DMG'] },
          description: 'Acceptable conditions (default: ["NM", "LP"])',
        },
        foil: { type: 'boolean', description: 'Foil versions (default: false)' },
      },
      required: ['cards'],
    },
  },
  {
    name: 'get_account',
    description: 'Test authentication and retrieve Manapool account details.',
    inputSchema: { type: 'object', properties: {} },
  },
];

async function handleGetCardPrice({ name, conditions, foil = false }) {
  const conditionIds = conditions || ['NM', 'LP'];
  const finishIds = foil ? ['FO'] : ['NF'];

  const { data, unavailable } = await runOptimizer([name], conditionIds, finishIds);

  if (unavailable.includes(name)) {
    return `"${name}" is not currently listed on Manapool.`;
  }

  const totals = data.totals || {};
  const subtotal = (totals.subtotal_cents || 0) / 100;
  const shipping = (totals.shipping_cents || 0) / 100;
  const buyerFee = (totals.buyer_fee_cents || 0) / 100;
  const total = (totals.total_cents || 0) / 100;

  return JSON.stringify({
    card: name,
    price: `$${subtotal.toFixed(2)}`,
    estimated_shipping: `$${shipping.toFixed(2)}`,
    buyer_fee: `$${buyerFee.toFixed(2)}`,
    estimated_total: `$${total.toFixed(2)}`,
    conditions_accepted: conditionIds,
    foil,
  }, null, 2);
}

async function handlePriceDeck({ cards, conditions, foil = false }) {
  const conditionIds = conditions || ['NM', 'LP'];
  const finishIds = foil ? ['FO'] : ['NF'];

  const { data, unavailable } = await runOptimizer(cards, conditionIds, finishIds);

  const totals = data.totals || {};
  const stats = data.stats || {};
  const cartItems = data.cart || [];

  const subtotal = (totals.subtotal_cents || 0) / 100;
  const shipping = (totals.shipping_cents || 0) / 100;
  const buyerFee = (totals.buyer_fee_cents || 0) / 100;
  const total = (totals.total_cents || 0) / 100;
  const sellerCount = totals.seller_count || 0;
  const totalFound = cartItems.reduce((sum, i) => sum + (i.quantity_selected || 0), 0);

  return JSON.stringify({
    summary: {
      cards_requested: cards.length,
      cards_priced: totalFound,
      cards_not_on_manapool: unavailable.length,
      sellers_needed: sellerCount,
      card_subtotal: `$${subtotal.toFixed(2)}`,
      estimated_shipping: `$${shipping.toFixed(2)}`,
      buyer_fee: `$${buyerFee.toFixed(2)}`,
      estimated_total: `$${total.toFixed(2)}`,
      ...(stats.response_time ? { optimizer_time_s: (stats.response_time / 1000).toFixed(2) } : {}),
    },
    not_on_manapool: unavailable,
  }, null, 2);
}

async function handleGetAccount() {
  // Try known buyer account endpoints
  for (const path of ['/buyer/account', '/account', '/buyer/profile']) {
    const { status, data } = await mpFetch(path);
    if (status === 200) return JSON.stringify(data, null, 2);
  }
  // If none work, return auth confirmation via a lightweight optimizer call
  const testRes = await fetch(`${API_BASE}/buyer/optimizer`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'X-ManaPool-Access-Token': API_KEY,
      ...(API_EMAIL ? { 'X-ManaPool-Email': API_EMAIL } : {}),
    },
    body: JSON.stringify({ cart: [{ type: 'mtg_single', name: 'Sol Ring', quantity_requested: 1, condition_ids: ['NM'], finish_ids: ['NF'], language_ids: ['EN'] }] }),
  });
  if (testRes.status === 200 || testRes.status === 409) {
    return JSON.stringify({ authenticated: true, email: API_EMAIL, note: 'Auth confirmed via optimizer ping; no dedicated account endpoint found.' }, null, 2);
  }
  return JSON.stringify({ authenticated: false, status: testRes.status }, null, 2);
}

const server = new Server({ name: 'manapool-mcp', version: '1.0.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    const handlers = {
      get_card_price: handleGetCardPrice,
      price_deck: handlePriceDeck,
      get_account: handleGetAccount,
    };
    if (!handlers[name]) throw new Error(`Unknown tool: ${name}`);
    const result = await handlers[name](args);
    return { content: [{ type: 'text', text: result }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('Manapool MCP server running...');
