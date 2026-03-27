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

async function mpFetch(path, options = {}) {
  const url = `${API_BASE}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${API_KEY}`,
      ...(API_EMAIL ? { 'X-API-Email': API_EMAIL } : {}),
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) throw new Error(`Manapool API error ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

const TOOLS = [
  {
    name: 'search_cards',
    description: 'Search for MTG cards on Manapool by name.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Card name to search for' },
        exact: { type: 'boolean', description: 'Exact name match only' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_card_price',
    description: 'Get the best available price for a card on Manapool.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        set_code: { type: 'string', description: '3-letter set code' },
        condition: { type: 'string', enum: ['NM', 'LP', 'MP', 'HP', 'DMG'] },
        foil: { type: 'boolean' },
      },
      required: ['name'],
    },
  },
  {
    name: 'price_deck',
    description: 'Price a full list of cards on Manapool. Returns per-card prices and total.',
    inputSchema: {
      type: 'object',
      properties: {
        cards: { type: 'array', items: { type: 'string' }, description: 'Array of card names' },
        condition: { type: 'string', enum: ['NM', 'LP', 'MP', 'HP', 'DMG'] },
      },
      required: ['cards'],
    },
  },
  {
    name: 'get_account',
    description: 'Get authenticated Manapool account details (good for testing auth).',
    inputSchema: { type: 'object', properties: {} },
  },
];

async function handleSearchCards({ name, exact = false }) {
  const params = new URLSearchParams({ q: name });
  if (exact) params.set('exact', 'true');
  return JSON.stringify(await mpFetch(`/cards?${params}`), null, 2);
}

async function handleGetCardPrice({ name, set_code, condition, foil }) {
  const params = new URLSearchParams({ q: name });
  if (set_code) params.set('set', set_code);
  if (condition) params.set('condition', condition);
  if (foil) params.set('foil', 'true');
  const data = await mpFetch(`/cards?${params}`);
  const listings = Array.isArray(data) ? data : data.listings || data.results || data.data || [];
  if (!listings.length) return `No listings found for "${name}".`;
  const sorted = listings.filter(l => l.price != null).sort((a, b) => parseFloat(a.price) - parseFloat(b.price));
  if (!sorted.length) return JSON.stringify(data, null, 2);
  const prices = sorted.map(l => parseFloat(l.price));
  const avg = (prices.reduce((a, b) => a + b, 0) / prices.length).toFixed(2);
  return JSON.stringify({
    card: name,
    lowest_price: sorted[0].price,
    lowest_seller: sorted[0].seller_name || sorted[0].seller || 'unknown',
    average_price: avg,
    total_listings: sorted.length,
    sample_listings: sorted.slice(0, 5).map(l => ({
      price: l.price, condition: l.condition,
      set: l.set_name || l.set || l.set_code,
      seller: l.seller_name || l.seller,
      foil: l.foil || false, qty: l.quantity || l.qty,
    })),
  }, null, 2);
}

async function handlePriceDeck({ cards, condition = 'NM' }) {
  const results = [];
  let totalMin = 0;
  const notFound = [];
  for (const cardName of cards) {
    try {
      const params = new URLSearchParams({ q: cardName, condition });
      const data = await mpFetch(`/cards?${params}`);
      const listings = Array.isArray(data) ? data : data.listings || data.results || data.data || [];
      const sorted = listings.filter(l => l.price != null).sort((a, b) => parseFloat(a.price) - parseFloat(b.price));
      if (sorted.length) {
        const lowestPrice = parseFloat(sorted[0].price);
        totalMin += lowestPrice;
        results.push({ card: cardName, lowest_price: lowestPrice, listings_available: sorted.length, condition: sorted[0].condition, set: sorted[0].set_name || sorted[0].set || 'unknown' });
      } else {
        notFound.push(cardName);
        results.push({ card: cardName, lowest_price: null, listings_available: 0 });
      }
    } catch (err) {
      results.push({ card: cardName, error: err.message });
    }
    await new Promise(r => setTimeout(r, 100));
  }
  return JSON.stringify({
    summary: { total_cards: cards.length, cards_found: results.filter(r => r.lowest_price != null).length, cards_not_found: notFound.length, estimated_total_min: `$${totalMin.toFixed(2)}` },
    not_found: notFound,
    results: results.sort((a, b) => (b.lowest_price || 0) - (a.lowest_price || 0)),
  }, null, 2);
}

async function handleGetAccount() {
  return JSON.stringify(await mpFetch('/account'), null, 2);
}

const server = new Server({ name: 'manapool-mcp', version: '1.0.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    const handlers = { search_cards: handleSearchCards, get_card_price: handleGetCardPrice, price_deck: handlePriceDeck, get_account: handleGetAccount };
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
