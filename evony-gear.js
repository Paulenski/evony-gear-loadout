/* =========================================
   Evony Gear Selector - script.js
   Backend: Google Apps Script Web App (public)
   Columns:
     Gear: name, slot, setname, tier, attr1..attr4, imageurl
     Set Bonus: Set, Tier, 2/2 Bonus, 4/4 Bonus, 6/6 Bonus
   - Prefers setname (fallback to tier) for grouping and bonuses
   - Clear, compact set-bonus containers (always show 2/2, 4/4, 6/6 lines)
   - Event delegation (no fragile inline JSON)
   - Idempotent initialization
   ========================================= */
(function () {
  if (window.EvonyGearInitialized) {
    console.info('Evony Gear: already initialized; skipping.');
    return;
  }
  window.EvonyGearInitialized = true;

  // CONFIG: Your deployed Apps Script Web App URL (must end with /exec)
  const ENDPOINT_URL = 'https://script.google.com/macros/s/AKfycbzl_MtXcoQ6bjUbVqnmRDp-sv1DRuea0eG2KrsXHi2qv-o7M0FEoE4mO5nDgZ5Qx5CcSQ/exec';
  const ENDPOINT_TOKEN = ''; // optional: set if you added ACCESS_TOKEN in Apps Script

  // Namespaced shared state
  const S = (window.EvonyGearState = window.EvonyGearState || {});
  S.equippedGear = S.equippedGear || {
    weapon: null, helmet: null, chest: null, legs: null, boots: null, ring: null
  };
  S.allItems = S.allItems || [];
  S.setBonusData = S.setBonusData || {};   // raw object from backend
  S.setBonusIndex = S.setBonusIndex || {}; // normalized index built from raw
  S.currentSlot = S.currentSlot || null;

  const SLOT_LABELS = {
    weapon: 'Weapon', helmet: 'Helmet', chest: 'Chest Armor',
    legs: 'Leg Armor', boots: 'Boots', ring: 'Ring'
  };

  // Normalizers
  function normalizeSlot(s) {
    const x = (s || '').toString().trim().toLowerCase();
    switch (x) {
      case 'weapon': return 'weapon';
      case 'helmet': return 'helmet';
      case 'chest':
      case 'chest armor':
      case 'chest armour': return 'chest';
      case 'leg':
      case 'legs':
      case 'leg armor':
      case 'leg armour': return 'legs';
      case 'boots': return 'boots';
      case 'ring': return 'ring';
      default: return x;
    }
  }
  function normalizeKey(s) {
    return (s || '').toString().trim().toLowerCase();
  }
  function getItemSetName(item) {
    // Prefer setname, fallback to set (if backend provides it)
    return (item?.setname || item?.set || '').toString().trim();
  }

  // UI helper
  function showError(message) {
    const container = document.querySelector('.container');
    if (!container) return;
    const div = document.createElement('div');
    div.style.cssText =
      'background:#7a1f1f;padding:12px;border-radius:6px;margin-bottom:12px;text-align:center;';
    div.innerHTML = `<strong>⚠️ Error:</strong> ${message}`;
    container.insertBefore(div, container.firstChild);
  }

  // Attribute handling
  function getAttributesString(item) {
    const parts = [];
    ['attr1', 'attr2', 'attr3', 'attr4'].forEach((k) => {
      const v = (item?.[k] || '').trim();
      if (v) parts.push(v);
    });
    if (parts.length === 0 && item?.attributes) return item.attributes.trim();
    return parts.join(', ');
  }

  // Parse a string like "Name: +12.5%", "Name +12.5%", "Name %: +12.5", "Name:+1,500"
function parseAndAddStats(attributeString, statsObject) {
  if (!attributeString) return;

  attributeString
    .split(/[,;]+/)              // comma or semicolon separated
    .map(s => s.trim())
    .filter(Boolean)
    .forEach(tok => {
      // Allow optional colon, allow 1,234 style, capture optional %
      // 1: stat name (greedy but minimal via +?), 2: signed number with commas, 3: % if present
      const m = tok.match(/^(.+?)(?::)?\s*([+-]?\d[\d,]*(?:\.\d+)?)\s*(%?)$/i);
      if (!m) return;

      let name = m[1].trim();
      let numStr = m[2].replace(/,/g, '');  // drop thousands separators
      const hadPercentInValue = m[3] === '%';
      const nameAlreadyHasPercent = /%/.test(name);

      const value = parseFloat(numStr);
      if (isNaN(value)) return;

      // If the value had a % but the name doesn't, append a % marker to stat name
      if (hadPercentInValue && !nameAlreadyHasPercent) {
        name = `${name} %`;
      }

      // Canonicalize "Name  %" -> "Name %"
      name = name.replace(/\s+%$/, ' %');

      statsObject[name] = (statsObject[name] || 0) + value;
    });
}

  // Fetch from Apps Script
  async function fetchJSON(url) {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  }

  // Build normalized index from raw bonuses: keys may be set names or tiers
  function buildBonusIndex(rawBonuses) {
    const idx = {};
    Object.keys(rawBonuses || {}).forEach((displayKey) => {
      const norm = normalizeKey(displayKey);
      const pieces = rawBonuses[displayKey] || {};
      idx[norm] = {
        displayKey,
        pieces: {
          2: pieces[2] || '',
          4: pieces[4] || '',
          6: pieces[6] || ''
        }
      };
    });
    return idx;
  }

  async function loadAllData() {
    try {
      const qs = new URLSearchParams({ action: 'all' });
      if (ENDPOINT_TOKEN) qs.set('key', ENDPOINT_TOKEN);
      const data = await fetchJSON(`${ENDPOINT_URL}?${qs.toString()}`);

      if (data.error) {
        showError(data.message || 'Backend error.');
        return;
      }

      // Items: normalize slot; keep setname, tier, attr1..attr4, imageurl
      S.allItems = (data.items || []).map((i) => ({
        ...i,
        slot: normalizeSlot(i.slot)
      }));

      // Bonuses: index by normalized key (set or tier name)
      S.setBonusData = data.bonuses || {};
      S.setBonusIndex = buildBonusIndex(S.setBonusData);

      console.log('EvonyGear: loaded items:', S.allItems.length);
      console.log('EvonyGear: loaded bonus keys:', Object.keys(S.setBonusData));
    } catch (e) {
      console.error(e);
      showError('Failed to load data from Apps Script. Check Web App URL and access.');
    }
  }

  // Choose the bonus key for a piece: prefer setname, else tier
  function getBonusKeyForItem(item) {
    const setName = getItemSetName(item);
    return setName || item?.tier || '';
  }

function setOrderIndex(str) {
  const key = setOrderKey(str);
  if (!key) return 999; // unknown sets go to the end
  const idx = SET_ORDER.indexOf(key);
  return idx === -1 ? 999 : idx;
}
// Safely escape any text we inject into HTML
function esc(s) {
  const div = document.createElement('div');
  div.textContent = s ?? '';
  return div.innerHTML;
}

// Return up to 4 attribute lines from attr1..attr4; fallback to splitting a single "attributes" string
function getAttributesArray(item) {
  const parts = [];
  ['attr1', 'attr2', 'attr3', 'attr4'].forEach((k) => {
    const v = (item?.[k] || '').trim();
    if (v) parts.push(v);
  });
  if (!parts.length && item?.attributes) {
    // split a combined attributes cell into tokens
    const tokens = item.attributes.split(/[,;]+/).map(s => s.trim()).filter(Boolean);
    parts.push(...tokens);
  }
  return parts.slice(0, 4);
}

  // PUBLIC functions
  window.openGearModal =
    window.openGearModal ||
    function openGearModal(slot) {
      S.currentSlot = slot;
      const modal = document.getElementById('itemModal');
      const modalTitle = document.getElementById('modalTitle');
      const modalBody = document.getElementById('modalBody');

      if (!modal || !modalTitle || !modalBody) {
        showError('Modal elements not found in HTML.');
        return;
      }

      modalTitle.textContent = `Select ${SLOT_LABELS[slot] || slot}`;

      // Items for this slot
      const slotItems = S.allItems.filter((item) => (item.slot || '').toLowerCase() === slot);

      // Prefer grouping by setname if any item has it; else group by tier
      const itemsHaveSet = slotItems.some((it) => getItemSetName(it).length > 0);
      const groupGetter = (it) => (itemsHaveSet ? (getItemSetName(it) || 'Unknown Set') : (it.tier || 'Unknown Tier'));

      // Build groups
      const groups = {};
      slotItems.forEach((item) => {
        const key = groupGetter(item);
        (groups[key] ||= []).push(item);
      });

      let html = `
        <div class="search-container">
          <input type="text" id="itemSearch" class="search-input" placeholder="🔍 Search items..." onkeyup="filterItems()">
        </div>
        <div class="item-card" data-item-idx="-1">
          <div class="item-name">❌ Remove Item</div>
          <div class="item-attributes">Clear this slot</div>
        </div>
        <div class="tier-divider"></div>
      `;

      // Sort groups: numeric when looks like "Tier X", otherwise alphabetic
      const groupNames = Object.keys(groups).sort((a, b) => {
  if (itemsHaveSet) {
    const ia = setOrderIndex(a);
    const ib = setOrderIndex(b);
    if (ia !== ib) return ia - ib;
    return a.localeCompare(b); // stable fallback within same bucket
  } else {
    const na = parseInt((a.match(/\d+/) || [0])[0], 10);
    const nb = parseInt((b.match(/\d+/) || [0])[0], 10);
    if ((/tier/i.test(a) || /tier/i.test(b)) && (na || nb)) return nb - na;
    return a.localeCompare(b);
  }
});

      const itemsFlat = [];

      groupNames.forEach((name) => {
  const items = groups[name];
  const hasSelectedInGroup = items.some((it) => S.equippedGear[slot]?.name === it.name);

  // Build the count label safely
  const countLabel = `${items.length} ${items.length === 1 ? 'item' : 'items'}`;

  html += `
    <div class="tier-section ${hasSelectedInGroup ? 'selected' : ''}">
      <div class="tier-header">
        <div class="tier-title">${name}</div>
        <span class="tier-count">${countLabel}</span>
      </div>
      <div class="tier-items">
  `;

  items.forEach((item) => {
    const idx = itemsFlat.length;
itemsFlat.push(item);
const isSelected = S.equippedGear[slot]?.name === item.name;

// Build bullet list from attr1..attr4 (fallback to split attributes string)
const attrs = getAttributesArray(item);
const listHtml = attrs.length
  ? `<ul class="attr-list">${attrs.map(a => `<li>${esc(a)}</li>`).join('')}</ul>`
  : `<ul class="attr-list"><li>No attributes</li></ul>`;

// Keep a hidden plain-text attributes div for searching/filtering
const hiddenAttrText = esc(getAttributesString(item) || '');

html += `
  <div class="item-card ${isSelected ? 'selected' : ''}" data-item-idx="${idx}">
    <div class="item-name" style="color:#ffd700;font-weight:800;">${esc(item.name)}</div>
    ${listHtml}
    <div class="item-attributes" style="display:none;">${hiddenAttrText}</div>
  </div>
`;

  });

  html += `
      </div>
    </div>
    <div class="tier-divider"></div>
  `;
});

      if (!groupNames.length) {
        html = '<p style="text-align:center;color:#888;">No items available for this slot</p>';
      }

      modalBody.innerHTML = html;
      modalBody._itemsCache = itemsFlat;

      modalBody.onclick = function (e) {
        const card = e.target.closest('.item-card');
        if (!card) return;
        const idx = parseInt(card.dataset.itemIdx, 10);
        if (idx === -1 || isNaN(idx)) {
          window.selectItem && window.selectItem(null);
        } else {
          window.selectItem && window.selectItem(modalBody._itemsCache[idx]);
        }
      };

      modal.style.display = 'block';
    };

  window.closeModal =
    window.closeModal ||
    function closeModal() {
      const modal = document.getElementById('itemModal');
      if (modal) modal.style.display = 'none';
    };

  window.filterItems =
  window.filterItems ||
  function filterItems() {
    const q = (document.getElementById('itemSearch')?.value || '').toLowerCase();
    document.querySelectorAll('#itemModal .item-card').forEach((card) => {
      const name = card.querySelector('.item-name')?.textContent.toLowerCase() || '';
      const attrHidden = card.querySelector('.item-attributes')?.textContent.toLowerCase() || '';
      const attrListText = card.querySelector('.attr-list')?.textContent.toLowerCase() || '';
      const isRemove = card.dataset.itemIdx === '-1';
      const matches = (
        isRemove ||
        name.includes(q) ||
        attrHidden.includes(q) ||
        attrListText.includes(q)
      );
      card.style.display = matches ? 'block' : 'none';
    });
  };

  window.selectItem =
    window.selectItem ||
    function selectItem(item) {
      S.equippedGear[S.currentSlot] = item;
      updateGearDisplay();
      updateStatsDisplay();
      updateSetBonuses();
      saveToLocalStorage();
      window.closeModal();
    };

  window.clearAll =
    window.clearAll ||
    function clearAll() {
      if (!confirm('Clear all equipped items?')) return;
      Object.keys(S.equippedGear).forEach((k) => (S.equippedGear[k] = null));
      updateGearDisplay();
      updateStatsDisplay();
      updateSetBonuses();
      saveToLocalStorage();
    };

  // Internal UI updaters
  function updateGearDisplay() {
    Object.keys(S.equippedGear).forEach((slot) => {
      const slotEl = document.querySelector(`.gear-slot[data-slot="${slot}"]`);
      if (!slotEl) return;
      const contentEl = slotEl.querySelector('.gear-slot-content');
      const item = S.equippedGear[slot];

      if (item) {
        slotEl.classList.add('equipped');
        slotEl.title = item.name || SLOT_LABELS[slot] || slot;
        contentEl.innerHTML = `
          <div class="badge-tier">${getItemSetName(item) || item.tier || ''}</div>
          <div class="checkmark">✓</div>
        `;
      } else {
        slotEl.classList.remove('equipped');
        slotEl.title = SLOT_LABELS[slot] || slot;
        contentEl.innerHTML = '';
      }
    });
  }

  function updateStatsDisplay() {
    const stats = {};

    // Gear stats
    Object.values(S.equippedGear).forEach((item) => {
      if (!item) return;
      const attrStr = getAttributesString(item);
      parseAndAddStats(attrStr, stats);
    });

    // Set bonuses (prefer setname; else tier)
    const counts = {};
    Object.values(S.equippedGear).forEach((item) => {
      if (!item) return;
      const key = normalizeKey(getBonusKeyForItem(item));
      if (!key) return;
      counts[key] = (counts[key] || 0) + 1;
    });

    Object.entries(counts).forEach(([normKey, count]) => {
      const entry = S.setBonusIndex[normKey];
      if (!entry) {
        console.warn('No bonuses found for key:', normKey, 'Available:', Object.keys(S.setBonusIndex));
        return;
      }
      [2, 4, 6].forEach((pc) => {
        if (count >= pc && entry.pieces[pc]) {
          parseAndAddStats(entry.pieces[pc], stats);
        }
      });
    });

    const statsDisplay = document.getElementById('statsDisplay');
    if (!statsDisplay) return;
    if (!Object.keys(stats).length) {
      statsDisplay.innerHTML =
        '<p style="text-align:center;color:#888;">Equip items to see stats</p>';
      return;
    }

    const html = Object.entries(stats)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(
        ([k, v]) => `
        <div class="stat-item">
          <span class="stat-label">${k}</span>
          <span class="stat-value">${k.endsWith(' %') ? `+${v.toLocaleString()}%` : `+${v.toLocaleString()}`}</span>
        </div>
      `
      )
      .join('');
    statsDisplay.innerHTML = html;
  }

  // New compact set-bonus containers
  function updateSetBonuses() {
    const counts = {};
    const itemsByKey = {};
    Object.values(S.equippedGear).forEach((item) => {
      if (!item) return;
      const rawKey = getBonusKeyForItem(item);
      const normKey = normalizeKey(rawKey);
      if (!normKey) return;
      counts[normKey] = (counts[normKey] || 0) + 1;
      (itemsByKey[normKey] ||= []).push(item.name);
    });

    const holder = document.getElementById('bonusDisplay');
    if (!holder) return;

    if (!Object.keys(counts).length) {
      holder.innerHTML =
        '<p style="text-align:center;color:#888;grid-column:1/-1;">No set bonuses active</p>';
      return;
    }

   // Build compact containers
let html = '<div class="set-grid">';

// Sort by preferred order using the display name (set if present, else tier)
const normKeysSorted = Object.keys(counts).sort((a, b) => {
  const aName = (S.setBonusIndex[a]?.displayKey || a);
  const bName = (S.setBonusIndex[b]?.displayKey || b);
  const ia = setOrderIndex(aName);
  const ib = setOrderIndex(bName);
  if (ia !== ib) return ia - ib;
  return aName.localeCompare(bName);
});

normKeysSorted.forEach((normKey) => {
  const count = counts[normKey];
  const entry = S.setBonusIndex[normKey];
  const displayName = entry?.displayKey || normKey;

  const lines = [
    { th: '2/2', pc: 2, text: entry?.pieces?.[2] || '—' },
    { th: '4/4', pc: 4, text: entry?.pieces?.[4] || '—' },
    { th: '6/6', pc: 6, text: entry?.pieces?.[6] || '—' },
  ];

  html += `
    <div class="set-box">
      <div class="set-title">
        <span>${displayName}</span>
        <span class="count">${count}/6</span>
      </div>
      <div class="set-lines">
        ${lines.map(line => `
          <div class="set-line ${count >= line.pc && line.text !== '—' ? 'active' : 'inactive'}">
            <div class="th">${line.th}</div>
            <div class="desc">${line.text}</div>
          </div>
        `).join('')}
      </div>
    </div>
  `;
});

html += '</div>';
holder.innerHTML = html;
  }

  // Storage
  function saveToLocalStorage() {
    try { localStorage.setItem('evonyGearBuild', JSON.stringify(S.equippedGear)); } catch {}
  }
  function loadFromLocalStorage() {
    try {
      const s = localStorage.getItem('evonyGearBuild');
      if (!s) return;
      const parsed = JSON.parse(s);
      if (parsed && typeof parsed === 'object') S.equippedGear = parsed;
    } catch {}
  }

  // Close modal on backdrop click
  window.addEventListener('click', (e) => {
    const modal = document.getElementById('itemModal');
    if (e.target === modal) window.closeModal();
  });

  // Initialize
  document.addEventListener('DOMContentLoaded', async () => {
    await loadAllData();
    loadFromLocalStorage();
    updateGearDisplay();
    updateStatsDisplay();
    updateSetBonuses();
  });
})();
// Preferred set display order
const SET_ORDER = ['dragon', 'ares', 'ach', 'imperial', 'parthian', 'asura', 'apollo'];

// Aliases to detect sets by name (normalized, lowercased, non-alphanumerics removed)
const SET_ALIASES = {
  dragon:    ['dragon'],
  ares:      ['ares'],
  ach:       ['achaemenidae','achaemenid','achae','ach'], // Achaemenidae family
  imperial:  ['imperial'],
  parthian:  ['parthian'],
  asura:     ['asura'],
  apollo:    ['apollo']
};

function setOrderKey(str) {
  const n = (str || '').toString().trim().toLowerCase();
  // remove non-alphanumeric to make matching robust
  const norm = n.replace(/[^a-z0-9]/g, '');
  for (const [key, needles] of Object.entries(SET_ALIASES)) {
    if (needles.some(term => norm.includes(term))) return key;
  }
  return null;
}
