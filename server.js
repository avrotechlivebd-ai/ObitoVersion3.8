const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const fetch = require('node-fetch');
const puppeteer = require('puppeteer');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// In-memory storage (production এ Redis use করবেন)
let results = [];
let apolloCredits = 50;

// Email থেকে username generate
function generateUsernames(email) {
  const local = email.split('@')[0];
  const patterns = [
    local,
    local.replace(/\./g, ''),
    local.replace(/[^a-zA-Z]/g, ''),
    local.split('.')[0] + local.split('.')[1],
    local.split('.')[0] + local.split('.')[1][0],
  ];
  return [...new Set(patterns)].slice(0, 5);
}

// Layer 1: Pattern Matching + Direct Check
async function layer1(email) {
  const usernames = generateUsernames(email);
  const checks = usernames.map(async (username) => {
    const url = `https://www.linkedin.com/in/${username}`;
    try {
      const res = await fetch(url, { method: 'HEAD' });
      return res.status === 200 ? url : null;
    } catch {
      return null;
    }
  });
  const results = await Promise.all(checks);
  return results.find(r => r);
}

// Layer 2: Google Dork Search
async function layer2(email) {
  const query = `"${email}" site:linkedin.com`;
  const url = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
  try {
    const res = await fetch(url);
    const html = await res.text();
    const $ = cheerio.load(html);
    const link = $('a[href*="linkedin.com/in"]').first().attr('href');
    return link || null;
  } catch {
    return null;
  }
}

// Layer 3: Apollo API
async function layer3(email, apolloKey) {
  if (apolloCredits <= 0) return null;
  
  try {
    const response = await axios.post('https://api.apollo.io/v1/mixed_people/search', {
      q_emails: [email],
      per_page: 1
    }, {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
      auth: { username: apolloKey, password: '' }
    });
    
    const person = response.data.people[0];
    apolloCredits--;
    return person?.linkedin_url || null;
  } catch (e) {
    console.log('Apollo credits exhausted');
    return null;
  }
}

// Layer 4: Reverse Domain Lookup (simplified)
async function layer4(email) {
  const domain = email.split('@')[1];
  const company = domain.replace('.com', '');
  const searchUrl = `https://www.google.com/search?q=${company}+linkedin`;
  try {
    const res = await fetch(searchUrl);
    const html = await res.text();
    const $ = cheerio.load(html);
    // Simple heuristic
    const links = $('a[href*="linkedin.com/in"]');
    return links.length > 0 ? links.first().attr('href') : null;
  } catch {
    return null;
  }
}

app.post('/api/check-emails', async (req, res) => {
  const { emails, apolloKey } = req.body;
  const finalResults = [];
  
  for (let email of emails) {
    const result = {
      email,
      linkedin: null,
      layers: [],
      confidence: 0
    };
    
    console.log(`Checking: ${email}`);
    
    // Layer 1
    const l1 = await layer1(email);
    if (l1) {
      result.linkedin = l1;
      result.layers.push('Layer 1 ✓');
      result.confidence += 30;
    }
    
    // Layer 2  
    if (!result.linkedin) {
      const l2 = await layer2(email);
      if (l2) {
        result.linkedin = l2;
        result.layers.push('Layer 2 ✓');
        result.confidence += 25;
      }
    }
    
    // Layer 3: Apollo (credits থাকলে)
    if (!result.linkedin && apolloKey && apolloCredits > 0) {
      const l3 = await layer3(email, apolloKey);
      if (l3) {
        result.linkedin = l3;
        result.layers.push('Layer 3 (Apollo) ✓');
        result.confidence += 40;
      }
    }
    
    // Layer 4
    if (!result.linkedin) {
      const l4 = await layer4(email);
      if (l4) {
        result.linkedin = l4;
        result.layers.push('Layer 4 ✓');
        result.confidence += 20;
      }
    }
    
    // Failed layers
    const allLayers = ['Layer 1', 'Layer 2', 'Layer 3', 'Layer 4'];
    result.failedLayers = allLayers.filter(layer => !result.layers.includes(layer));
    
    finalResults.push(result);
    await new Promise(r => setTimeout(r, 2000)); // Rate limit
  }
  
  results = finalResults;
  res.json({ results, apolloCredits });
});

app.get('/api/results', (req, res) => {
  res.json(results);
});

app.listen(3000, () => {
  console.log('🚀 Server running on http://localhost:3000');
});
